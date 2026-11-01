/**
 * Building snapshots: from the real file system, from an in-memory object
 * (for tests), and from/to JSON.
 */
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { createIgnoreMatcher } from "./ignore.js";
import { escapeJsonForTerminal } from "./quote.js";
import {
  compareNames,
  decodeName,
  escapeInvalidName,
  fastContentHash,
  joinPath,
  makeDirectory,
  sha256,
  SNAPSHOT_ERROR_KINDS,
  SNAPSHOT_VERSION,
  symlinkNode,
  unescapeInvalidName,
  type DirectoryNode,
  type FsNode,
  type Snapshot,
  type SnapshotError,
  type SnapshotErrorKind,
  type SnapshotOptions,
} from "./model.js";

export interface BuildOptions {
  /** Names or simple globs to skip, e.g. `["node_modules", ".git", "*.log"]`. See ignore.ts. */
  ignore?: string[];
  /**
   * Skip reading file contents and derive each file's hash from size + mtime.
   * Much faster on large trees, but a content change that keeps size and mtime
   * goes unnoticed, and a touch without a content change shows up as modified.
   */
  fast?: boolean;
  /**
   * Maximum number of file system operations in flight at once, and of entries
   * in progress per directory. A positive integer; default 32.
   */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 32;

/**
 * Walks `rootPath` recursively and returns a snapshot of everything under it.
 *
 * Symlinks are recorded but not followed. Entries below the root that cannot
 * be read, sockets/FIFOs/devices, and names that are not valid UTF-8 are left
 * out of the tree and listed in `snapshot.errors` with their kind. Entries
 * that vanish mid-scan are left out without an error, as if the scan had
 * started after they were deleted.
 *
 * Throws if the root is missing, is not a directory, or cannot be listed: a
 * snapshot with nothing in it would only produce a misleading diff later.
 */
export async function buildSnapshot(rootPath: string, options: BuildOptions = {}): Promise<Snapshot> {
  const absRoot = path.resolve(rootPath);
  const snapshotOptions: SnapshotOptions = { ignore: [...(options.ignore ?? [])], fast: options.fast ?? false };
  const isIgnored = createIgnoreMatcher(snapshotOptions.ignore);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const limit = createLimiter(concurrency);
  const errors: SnapshotError[] = [];
  const createdAt = new Date().toISOString();

  const rootStat = await fs.stat(absRoot);
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${absRoot}`);

  /** Reads one directory and all of its descendants. Throws only if this directory itself is unreadable. */
  async function walkDirectory(absPath: string, relPath: string, name: string, mode: number): Promise<DirectoryNode> {
    // Raw byte names: a string listing would replace invalid UTF-8 with U+FFFD,
    // which can't be told apart from a name that really contains U+FFFD.
    const entries = await limit(() => fs.readdir(absPath, { withFileTypes: true, encoding: "buffer" }));
    const kept: string[] = [];
    for (const entry of entries) {
      const name = decodeName(entry.name);
      const shownName = name ?? escapeInvalidName(entry.name);
      const childPath = joinPath(relPath, shownName);
      if (isIgnored(childPath, shownName, entry.isDirectory())) continue;
      if (name === undefined) {
        // Never lstat it: the name can't be passed back to the file system as a string.
        errors.push({ path: childPath, kind: "invalidName", message: "file name is not valid UTF-8; skipped" });
      } else {
        kept.push(name);
      }
    }
    // Bounded, not Promise.all(entries.map(...)): a directory with 200k entries
    // would otherwise create 200k pending promises at once.
    const children = await mapWithConcurrency(kept, concurrency, (childName) =>
      walkEntry(path.join(absPath, childName), joinPath(relPath, childName), childName),
    );
    return makeDirectory(name, mode, children.filter((child): child is FsNode => child !== null));
  }

  /** Turns one directory entry into a node, or records an error and returns null. */
  async function walkEntry(absPath: string, relPath: string, name: string): Promise<FsNode | null> {
    try {
      const stat = await limit(() => fs.lstat(absPath));
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        return symlinkNode(name, await limit(() => fs.readlink(absPath, { encoding: "buffer" })));
      }
      if (stat.isDirectory()) {
        return await walkDirectory(absPath, relPath, name, mode);
      }
      if (stat.isFile()) {
        const contentHash = snapshotOptions.fast
          ? fastContentHash(stat.size, stat.mtimeMs)
          : await limit(() => hashFile(absPath));
        return { type: "file", name, size: stat.size, mtimeMs: stat.mtimeMs, mode, contentHash };
      }
      // Never open sockets, FIFOs or devices: reading a FIFO would block forever.
      errors.push({ path: relPath, kind: "unsupported", message: "unsupported file type (socket, FIFO or device); skipped" });
      return null;
    } catch (err) {
      // Deleted (or its parent replaced by a file) after being listed, at any of
      // lstat, readlink, opening for hashing or a subdirectory's readdir: the
      // entry is simply absent, so a deletion during the scan diffs as a removal.
      if (isVanished(err)) return null;
      errors.push(toSnapshotError(relPath, err));
      return null;
    }
  }

  const root = await walkDirectory(absRoot, "", "", rootStat.mode & 0o7777);
  errors.sort((a, b) => compareNames(a.path, b.path));
  return { version: SNAPSHOT_VERSION, rootPath: absRoot, createdAt, options: snapshotOptions, root, errors };
}

/** SHA-256 of a file, streamed in chunks so memory use is constant regardless of file size. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  // Without an encoding a read stream yields Buffers; its declared type is only AsyncIterable<any>.
  const chunks: AsyncIterable<Buffer> = createReadStream(filePath);
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Returns a function that runs async tasks with at most `max` running at once.
 * Keeps a large tree from exhausting file descriptors (EMFILE).
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  assertConcurrency(max);
  let active = 0;
  // FIFO queue. A read index instead of Array.shift(), which is O(n) per call.
  let waiting: Array<() => void> = [];
  let head = 0;
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // a finishing task hands us its slot
    try {
      return await task();
    } finally {
      const next = waiting[head];
      if (next) {
        head++;
        if (head === waiting.length) {
          waiting = [];
          head = 0;
        }
        next();
      } else {
        active--;
      }
    }
  };
}

/**
 * Like `Promise.all(items.map(fn))`, but with at most `max` calls of `fn` in
 * progress at once. Results keep the order of `items`.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], max: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  assertConcurrency(max);
  const results: R[] = new Array<R>(items.length);
  // One iterator shared by every worker, so each item is taken exactly once.
  const queue = items.entries();
  async function worker(): Promise<void> {
    for (const [index, item] of queue) results[index] = await fn(item);
  }
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
  return results;
}

/** A concurrency of 0 would make every task wait forever, so reject it up front. */
function assertConcurrency(max: number): void {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`concurrency must be a positive integer, got ${max}`);
}

/** True if `err` means the entry no longer exists (ENOENT, or ENOTDIR when a parent directory was replaced by a file). */
function isVanished(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The `code` of a Node system error, if `err` has a string one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

/**
 * Converts anything thrown during the walk into a SnapshotError, without
 * assuming it is an Error. The entry was listed, so whatever went wrong it
 * exists and its state is unknown: always `unreadable`.
 */
export function toSnapshotError(relPath: string, err: unknown): SnapshotError {
  const kind = "unreadable";
  if (!(err instanceof Error)) return { path: relPath, kind, message: String(err) };
  const code = errorCode(err);
  return code !== undefined ? { path: relPath, kind, code, message: err.message } : { path: relPath, kind, message: err.message };
}

// ---------------------------------------------------------------------------
// In-memory snapshots, for tests and examples
// ---------------------------------------------------------------------------

const SPEC = Symbol("fs-spec");

/** A file in a {@link TreeSpec}. Create with {@link file}. */
export interface FileSpec {
  [SPEC]: "file";
  content: string | Uint8Array;
  mode?: number;
  mtimeMs?: number;
}

/** A symlink in a {@link TreeSpec}. Create with {@link symlink}. */
export interface SymlinkSpec {
  [SPEC]: "symlink";
  target: string | Uint8Array;
}

/** A directory with an explicit mode in a {@link TreeSpec}. Create with {@link directory}. */
export interface DirectorySpec {
  [SPEC]: "directory";
  children: TreeSpec;
  mode: number;
}

/**
 * A directory tree as a plain object: a string is a file with that content,
 * a nested plain object is a directory, and `file()` / `symlink()` / `directory()`
 * give more control.
 */
export interface TreeSpec {
  [name: string]: string | FileSpec | SymlinkSpec | DirectorySpec | TreeSpec;
}

/** True for a value made by file(), symlink() or directory(); false for a plain object (a directory). */
function isSpec(value: object): value is FileSpec | SymlinkSpec | DirectorySpec {
  return SPEC in value;
}

/** A file with explicit mode/mtime, for use inside a {@link TreeSpec}. */
export function file(content: string | Uint8Array, meta: { mode?: number; mtimeMs?: number } = {}): FileSpec {
  return { [SPEC]: "file", content, ...meta };
}

/**
 * A symlink pointing at `target`, for use inside a {@link TreeSpec}. Pass raw
 * bytes to get a target that is not valid UTF-8, as buildSnapshot records it.
 */
export function symlink(target: string | Uint8Array): SymlinkSpec {
  return { [SPEC]: "symlink", target };
}

/** A directory with an explicit mode, for use inside a {@link TreeSpec}. */
export function directory(children: TreeSpec, meta: { mode: number }): DirectorySpec {
  return { [SPEC]: "directory", children, mode: meta.mode };
}

const DEFAULT_DIRECTORY_MODE = 0o755;

export interface FromObjectOptions {
  rootPath?: string;
  /** Permission bits of the root directory (default 0o755). */
  rootMode?: number;
  createdAt?: string;
  fast?: boolean;
}

/**
 * Builds a snapshot from a plain nested object, without touching the disk.
 * Every node goes through the same checks as in {@link deserialize} (see
 * nodeProblem), so a tree that can't come from a real scan throws a TypeError.
 */
export function fromObject(spec: TreeSpec, options: FromObjectOptions = {}): Snapshot {
  const fast = options.fast ?? false;

  function check<N extends FsNode>(relPath: string, node: N, isRoot: boolean): N {
    const problem = nodeProblem(node, isRoot);
    if (problem !== undefined) throw new TypeError(`invalid tree spec at ${JSON.stringify(relPath)}: ${problem}`);
    return node;
  }

  function toNode(relPath: string, name: string, value: TreeSpec[string]): FsNode {
    return check(relPath, buildNode(relPath, name, value), false);
  }

  function buildNode(relPath: string, name: string, value: TreeSpec[string]): FsNode {
    if (typeof value === "string") return buildNode(relPath, name, file(value));
    if (typeof value !== "object" || value === null) {
      throw new TypeError(
        `invalid tree spec at ${JSON.stringify(relPath)}: expected a string, file(), symlink(), directory() or a plain object, got ${String(value)}`,
      );
    }
    if (!isSpec(value)) return toDirectory(relPath, name, value, DEFAULT_DIRECTORY_MODE);
    switch (value[SPEC]) {
      case "symlink":
        return typeof value.target === "string" ? { type: "symlink", name, target: value.target } : symlinkNode(name, value.target);
      case "directory":
        return toDirectory(relPath, name, value.children, value.mode);
      case "file": {
        const bytes = typeof value.content === "string" ? Buffer.from(value.content, "utf8") : value.content;
        const mtimeMs = value.mtimeMs ?? 0;
        return {
          type: "file",
          name,
          size: bytes.byteLength,
          mtimeMs,
          mode: value.mode ?? 0o644,
          contentHash: fast ? fastContentHash(bytes.byteLength, mtimeMs) : sha256(bytes),
        };
      }
    }
  }

  function toDirectory(relPath: string, name: string, dir: TreeSpec, mode: number): DirectoryNode {
    const children = Object.entries(dir).map(([childName, child]) => toNode(joinPath(relPath, childName), childName, child));
    return makeDirectory(name, mode, children);
  }

  const root = check("", toDirectory("", "", spec, options.rootMode ?? DEFAULT_DIRECTORY_MODE), true);

  return {
    version: SNAPSHOT_VERSION,
    rootPath: options.rootPath ?? "memory:",
    createdAt: options.createdAt ?? new Date().toISOString(),
    options: { ignore: [], fast },
    root,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serializes a snapshot to JSON. `deserialize(serialize(s))` deep-equals `s`.
 * Characters a terminal could act on are written as `\uXXXX` escapes (see
 * escapeJsonForTerminal), so printing a snapshot is safe too.
 */
export function serialize(snapshot: Snapshot, pretty = false): string {
  return escapeJsonForTerminal(JSON.stringify(snapshot, null, pretty ? 2 : undefined));
}

/**
 * Parses a snapshot from JSON, validating its shape and recomputing every
 * directory hash, so a corrupted or hand-edited file is rejected rather than
 * silently producing a wrong diff.
 *
 * Entry names are checked too: a child named "", ".", ".." or containing "/"
 * or NUL can't come from a real directory listing, and accepting one would let
 * a tampered snapshot put paths like `../../etc/passwd` into the diff output.
 * Numbers and `errors` entries are checked the same way. This only proves the
 * file is well formed and self-consistent, not that it is authentic.
 */
export function deserialize(json: string): Snapshot {
  const data: unknown = JSON.parse(json);
  if (!isRecord(data)) throw new Error("invalid snapshot: not an object");
  // Version first: another version may have other fields, and its reader needs this message, not "unknown field".
  if (data.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `unsupported snapshot version: ${JSON.stringify(data.version) ?? "missing"} (this version of fsdiff reads version ${SNAPSHOT_VERSION}; take the snapshot again)`,
    );
  }
  expectKeys(data, ["version", "rootPath", "createdAt", "options", "root", "errors"], "snapshot");
  expectType(data.rootPath, "string", "rootPath");
  expectType(data.createdAt, "string", "createdAt");

  const options = data.options;
  if (!isRecord(options) || !Array.isArray(options.ignore) || typeof options.fast !== "boolean") {
    throw new Error("invalid snapshot: bad options");
  }
  expectKeys(options, ["ignore", "fast"], "options");
  const ignore: unknown[] = options.ignore;
  if (!ignore.every((pattern): pattern is string => typeof pattern === "string")) {
    throw new Error("invalid snapshot: options.ignore must contain only strings");
  }
  if (!Array.isArray(data.errors)) throw new Error("invalid snapshot: errors must be an array");
  const errors = data.errors.map((entry: unknown, i) => parseError(entry, `errors[${i}]`));

  const root = parseNode(data.root, "root", true);
  // Its name is already checked to be "" (nodeProblem with isRoot).
  if (root.type !== "directory") throw new Error("invalid snapshot: root must be a directory");

  return {
    version: SNAPSHOT_VERSION,
    rootPath: data.rootPath,
    createdAt: data.createdAt,
    options: { ignore: [...ignore], fast: options.fast },
    root,
    errors,
  };
}

/** Validates one serialized SnapshotError. */
function parseError(entry: unknown, where: string): SnapshotError {
  if (!isRecord(entry)) throw new Error(`invalid snapshot: ${where} is not an object`);
  expectKeys(entry, ["path", "kind", "code", "message"], where);
  expectType(entry.path, "string", `${where}.path`);
  expectType(entry.message, "string", `${where}.message`);
  const kind = SNAPSHOT_ERROR_KINDS.find((k) => k === entry.kind);
  if (kind === undefined) {
    throw new Error(`invalid snapshot: ${where}.kind must be one of ${SNAPSHOT_ERROR_KINDS.join(", ")}`);
  }
  if (!isValidErrorPath(entry.path, kind)) {
    throw new Error(`invalid snapshot: ${where}.path ${JSON.stringify(entry.path)} is not a valid relative path`);
  }
  if (entry.code === undefined) return { path: entry.path, kind, message: entry.message };
  expectType(entry.code, "string", `${where}.code`);
  return { path: entry.path, kind, code: entry.code, message: entry.message };
}

/**
 * A `/`-joined path of valid entry names. For an `invalidName` error the last
 * segment must be exactly what escapeInvalidName produces for some name that
 * is not valid UTF-8.
 */
function isValidErrorPath(errorPath: string, kind: SnapshotErrorKind): boolean {
  const segments = errorPath.split("/");
  if (!segments.every(isValidEntryName)) return false;
  if (kind !== "invalidName") return true;
  return isEscapedInvalidUtf8(errorPath.slice(errorPath.lastIndexOf("/") + 1));
}

/** True if `text` is exactly what escapeInvalidName produces for some bytes that are not valid UTF-8. */
function isEscapedInvalidUtf8(text: string): boolean {
  const raw = unescapeInvalidName(text);
  return raw !== undefined && decodeName(raw) === undefined && escapeInvalidName(raw) === text;
}

/** Validates one serialized node and rebuilds it, checking directory hashes on the way. */
function parseNode(node: unknown, where: string, isRoot: boolean): FsNode {
  const parsed = parseNodeShape(node, where);
  const problem = nodeProblem(parsed, isRoot);
  if (problem !== undefined) throw new Error(`invalid snapshot: ${where}.${problem}`);
  if (parsed.type === "directory" && isRecord(node) && parsed.hash !== node.hash) {
    throw new Error(`invalid snapshot: hash mismatch at ${where} "${parsed.name}"`);
  }
  return parsed;
}

/** Checks the fields and their JSON types for the node's type, and builds the node (children included). */
function parseNodeShape(node: unknown, where: string): FsNode {
  if (!isRecord(node)) throw new Error(`invalid snapshot: ${where} is not an object`);
  expectType(node.name, "string", `${where}.name`);
  const name = node.name;

  switch (node.type) {
    case "file":
      expectKeys(node, ["type", "name", "size", "mtimeMs", "mode", "contentHash"], where);
      expectType(node.size, "number", `${where}.size`);
      expectType(node.mtimeMs, "number", `${where}.mtimeMs`);
      expectType(node.mode, "number", `${where}.mode`);
      expectType(node.contentHash, "string", `${where}.contentHash`);
      return { type: "file", name, size: node.size, mtimeMs: node.mtimeMs, mode: node.mode, contentHash: node.contentHash };
    case "symlink":
      expectKeys(node, ["type", "name", "target", "targetEscaped"], where);
      expectType(node.target, "string", `${where}.target`);
      if (node.targetEscaped === undefined) return { type: "symlink", name, target: node.target };
      if (node.targetEscaped !== true) throw new Error(`invalid snapshot: ${where}.${TARGET_ESCAPED_PROBLEM}`);
      return { type: "symlink", name, target: node.target, targetEscaped: true };
    case "directory": {
      expectKeys(node, ["type", "name", "mode", "children", "hash"], where);
      expectType(node.mode, "number", `${where}.mode`);
      // Checked before the children are hashed, so the error names the real problem.
      const modeProblem = checkMode(node.mode);
      if (modeProblem !== undefined) throw new Error(`invalid snapshot: ${where}.${modeProblem}`);
      if (!Array.isArray(node.children)) throw new Error(`invalid snapshot: ${where}.children is not an array`);
      const children = node.children.map((child: unknown, i) => parseNode(child, `${where}/${name || "."}[${i}]`, false));
      return makeDirectory(name, node.mode, children);
    }
    default:
      throw new Error(`invalid snapshot: ${where} has unknown type ${String(node.type)}`);
  }
}

const TARGET_ESCAPED_PROBLEM = "targetEscaped must be true and its target in the escape format";

/**
 * What is wrong with one node's own fields, or undefined if nothing is: the
 * single set of rules shared by {@link fromObject} and {@link deserialize},
 * so the two can't drift apart. Children are checked when they are built.
 *
 * - name: a valid entry name (the root's is "");
 * - file: `size` a non-negative safe integer, `mtimeMs` finite (fractional
 *   and pre-1970 values are real), `mode` permission bits only;
 * - directory: `mode` permission bits only;
 * - symlink: `target` non-empty without NUL (so it can never imitate the NUL
 *   prefix nodeHash gives escaped targets); if `targetEscaped`, the target is
 *   exactly in the escape format for bytes that are not valid UTF-8.
 */
export function nodeProblem(node: FsNode, isRoot: boolean): string | undefined {
  if (isRoot ? node.name !== "" : !isValidEntryName(node.name)) {
    return `name ${JSON.stringify(node.name)} is not a valid entry name`;
  }
  switch (node.type) {
    case "file":
      if (!Number.isSafeInteger(node.size) || node.size < 0) return `size must be a non-negative integer, got ${node.size}`;
      if (!Number.isFinite(node.mtimeMs)) return `mtimeMs must be finite, got ${node.mtimeMs}`;
      return checkMode(node.mode);
    case "directory":
      return checkMode(node.mode);
    case "symlink":
      if (node.target === "" || node.target.includes("\0")) return "target must be non-empty and contain no NUL byte";
      if (node.targetEscaped !== undefined && (node.targetEscaped !== true || !isEscapedInvalidUtf8(node.target))) {
        return TARGET_ESCAPED_PROBLEM;
      }
      return undefined;
  }
}

/** Permission bits only, as stored by buildSnapshot (`st_mode & 0o7777`). */
function checkMode(mode: number): string | undefined {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o7777 ? undefined : `mode must be an integer from 0 to 0o7777, got ${mode}`;
}

/** A single path component as a directory listing can return it. */
function isValidEntryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

/** Rejects any field not in `allowed`, so nothing in a snapshot file is silently dropped. */
function expectKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`invalid snapshot: ${where} has unknown field ${JSON.stringify(key)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TypeNames {
  string: string;
  number: number;
}

function expectType<K extends keyof TypeNames>(value: unknown, type: K, what: string): asserts value is TypeNames[K] {
  if (typeof value !== type) throw new Error(`invalid snapshot: ${what} must be a ${type}`);
}
