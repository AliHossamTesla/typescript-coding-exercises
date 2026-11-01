/**
 * Data model for a compact, content-addressed snapshot of a directory tree.
 *
 * Nothing here ever holds file contents: a file is described by its metadata
 * and a SHA-256 digest, and a directory by its children plus a Merkle hash that
 * summarises its whole subtree in 64 hex characters.
 */
import { createHash } from "node:crypto";

export type NodeType = "file" | "directory" | "symlink";

/** A regular file: metadata plus a digest of its contents. */
export interface FileNode {
  type: "file";
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last modification time, milliseconds since the epoch (may be fractional). */
  mtimeMs: number;
  /** Permission bits only (`st_mode & 0o7777`); the file type is in `type`. */
  mode: number;
  /** Hex SHA-256 of the contents (or, in fast mode, a hash of size + mtime). */
  contentHash: string;
}

/** A symbolic link. It is recorded, never followed. */
export interface SymlinkNode {
  type: "symlink";
  name: string;
  /**
   * The link target as returned by readlink (may be relative or dangling). If
   * its bytes are not valid UTF-8, this is their {@link escapeInvalidName} form
   * and `targetEscaped` is set.
   */
  target: string;
  /** Present (and true) only when `target` is escaped; see {@link symlinkNode}. */
  targetEscaped?: true;
}

/** A directory with its children and a Merkle hash of the whole subtree. */
export interface DirectoryNode {
  type: "directory";
  name: string;
  /** Permission bits only (`st_mode & 0o7777`). */
  mode: number;
  /** Children sorted by name (code-unit order); names are unique. */
  children: FsNode[];
  /** Merkle hash over the sorted children; see {@link directoryHash}. */
  hash: string;
}

export type FsNode = FileNode | DirectoryNode | SymlinkNode;

/** The options a snapshot was built with, stored so two snapshots can be checked for compatibility. */
export interface SnapshotOptions {
  /** Ignore patterns (names or simple globs) that were excluded from the walk. */
  ignore: string[];
  /** True if file hashes were derived from size + mtime instead of contents. */
  fast: boolean;
}

/**
 * Why a path is missing from the tree. Decided when the error is recorded, so
 * the diff never has to guess from error codes:
 * - `unreadable`: the entry exists but could not be read (permissions, I/O
 *   errors, ...). Its state is unknown, so the diff reports nothing there.
 * - `unsupported`: a socket, FIFO or device. Not tracked, so treated as absent.
 * - `invalidName`: the name is not valid UTF-8 (see {@link escapeInvalidName}).
 *   Treated like `unreadable`.
 */
export type SnapshotErrorKind = "unreadable" | "unsupported" | "invalidName";

export const SNAPSHOT_ERROR_KINDS: readonly SnapshotErrorKind[] = ["unreadable", "unsupported", "invalidName"];

/** A path that was left out of the tree while building the snapshot. */
export interface SnapshotError {
  /** Path relative to the snapshot root, `/`-separated. */
  path: string;
  kind: SnapshotErrorKind;
  /** Node error code such as EACCES, when available. */
  code?: string;
  message: string;
}

/** The state of one directory tree at one point in time. */
export interface Snapshot {
  /** Format version, bumped if the serialized shape ever changes. */
  version: typeof SNAPSHOT_VERSION;
  /** Absolute path of the root that was scanned (informational only). */
  rootPath: string;
  /** ISO-8601 timestamp of when the scan started. */
  createdAt: string;
  options: SnapshotOptions;
  /** The root directory. Its name is always "" so paths are relative to it. */
  root: DirectoryNode;
  /** Paths that were skipped because they could not be read. */
  errors: SnapshotError[];
}

export const SNAPSHOT_VERSION = 1;

/** Hex SHA-256 of a string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic name ordering (UTF-16 code-unit order), independent of locale.
 * Both building and diffing rely on this exact order for the linear merge.
 */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The identity of a node's content:
 * a file's content hash, a directory's Merkle hash, or a symlink's target.
 * An escaped target gets a NUL prefix, which no real target can contain, so
 * it never equals a target that literally reads `\xFF`.
 */
export function nodeHash(node: FsNode): string {
  switch (node.type) {
    case "file":
      return node.contentHash;
    case "directory":
      return node.hash;
    case "symlink":
      return node.targetEscaped ? `\0escaped:${node.target}` : node.target;
  }
}

/** A symlink node from the raw bytes of its target, escaping them if they are not valid UTF-8. */
export function symlinkNode(name: string, rawTarget: Uint8Array): SymlinkNode {
  const target = decodeName(rawTarget);
  return target === undefined
    ? { type: "symlink", name, target: escapeInvalidName(rawTarget), targetEscaped: true }
    : { type: "symlink", name, target };
}

/**
 * Stand-in for a content hash in fast mode. Cheap, but two different files with
 * the same size and mtime look identical, and a touch without a content change
 * looks like a modification.
 */
export function fastContentHash(size: number, mtimeMs: number): string {
  return sha256(`fast:${size}:${mtimeMs}`);
}

/**
 * Merkle hash of a directory: SHA-256 over the JSON list of
 * `[name, type, mode, hash]` for each child in sorted order.
 *
 * Mode is included so that a permission change also changes every ancestor's
 * hash; otherwise pruning on equal hashes would hide it. mtime is deliberately
 * not included. JSON encoding keeps the input unambiguous for any name.
 * The directory's own name is not part of its hash, so a renamed directory
 * keeps the same hash (which is what makes folder moves detectable).
 */
export function directoryHash(sortedChildren: readonly FsNode[]): string {
  const entries = sortedChildren.map((child) => [
    child.name,
    child.type,
    child.type === "symlink" ? null : child.mode,
    nodeHash(child),
  ]);
  return sha256(JSON.stringify(entries));
}

/**
 * Creates a directory node: sorts the children, rejects duplicate names and
 * computes the Merkle hash. Every DirectoryNode should be made through here.
 */
export function makeDirectory(name: string, mode: number, children: readonly FsNode[]): DirectoryNode {
  const sorted = [...children].sort((a, b) => compareNames(a.name, b.name));
  let previous: FsNode | undefined;
  for (const child of sorted) {
    if (previous?.name === child.name) throw new Error(`duplicate entry name "${child.name}" in directory "${name}"`);
    previous = child;
  }
  return { type: "directory", name, mode, children: sorted, hash: directoryHash(sorted) };
}

/** Joins a relative parent path and a child name with `/` (the root's path is ""). */
export function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes a raw file name, or returns undefined if it is not valid UTF-8. */
export function decodeName(raw: Uint8Array): string | undefined {
  try {
    return utf8.decode(raw);
  } catch {
    return undefined;
  }
}

/**
 * A printable, unambiguous stand-in for a name (or symlink target) that is not valid UTF-8: valid
 * characters are kept, every byte that is not part of a valid character becomes
 * `\xHH` (upper-case hex), and `\` becomes `\\`. Different byte names always
 * give different strings, and {@link unescapeInvalidName} reverses it.
 */
export function escapeInvalidName(raw: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    // UTF-8 is prefix-free, so at most one length decodes as one valid character.
    let char: string | undefined;
    let len = 1;
    for (; len <= 4 && i + len <= raw.length; len++) {
      char = decodeName(raw.subarray(i, i + len));
      if (char !== undefined) break;
    }
    if (char === undefined) {
      out += `\\x${Buffer.from(raw.subarray(i, i + 1)).toString("hex").toUpperCase()}`;
      i++;
    } else {
      out += char === "\\" ? "\\\\" : char;
      i += len;
    }
  }
  return out;
}

/** Reverses {@link escapeInvalidName}; undefined if `escaped` is not in that format. */
export function unescapeInvalidName(escaped: string): Uint8Array | undefined {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < escaped.length) {
    const next = escaped.indexOf("\\", i);
    const end = next === -1 ? escaped.length : next;
    if (end > i) parts.push(encoder.encode(escaped.slice(i, end)));
    if (next === -1) break;
    if (escaped[next + 1] === "\\") {
      parts.push(Uint8Array.of(0x5c));
      i = next + 2;
    } else {
      const hex = escaped.slice(next + 2, next + 4);
      if (escaped[next + 1] !== "x" || !/^[0-9A-F]{2}$/.test(hex)) return undefined;
      parts.push(Uint8Array.of(parseInt(hex, 16)));
      i = next + 4;
    }
  }
  return Buffer.concat(parts);
}
