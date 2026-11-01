import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diff } from "../../src/diff.js";
import type { FileNode } from "../../src/model.js";
import { buildSnapshot, deserialize, hashFile, serialize } from "../../src/snapshot.js";

let root: string;
/** Paths made unreadable by a test; afterEach restores them so cleanup can't fail. */
let locked: string[] = [];

/** Removes all permissions from a path and remembers to restore them. */
async function lock(target: string): Promise<void> {
  locked.push(target);
  await fs.chmod(target, 0o000);
}

/** Writes a file, creating parent directories. */
async function write(rel: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fsdiff-"));
});

afterEach(async () => {
  for (const target of locked.reverse()) await fs.chmod(target, 0o755).catch(() => {});
  locked = [];
  await fs.rm(root, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const isPosix = process.platform !== "win32";

describe("real file system", () => {
  it("snapshots, applies changes, snapshots again and reports the difference", async () => {
    await write("README.md", "hello");
    await write("src/index.ts", "export {}");
    await write("src/util/strings.ts", "export const a = 1;");
    await write("old-name.txt", "rename me");
    await write("lib/a.js", "a");
    await write("lib/b.js", "b");
    await write("script.sh", "#!/bin/sh");
    await write("gone.txt", "bye");
    await write("becomes-dir", "i am a file");
    await fs.symlink("README.md", path.join(root, "link"));

    const before = await buildSnapshot(root);
    expect(before.errors).toEqual([]);

    await write("src/index.ts", "export const x = 1;"); // modified
    await write("src/new/feature.ts", "new"); // added at depth
    await fs.rename(path.join(root, "old-name.txt"), path.join(root, "new-name.txt")); // file rename
    await fs.rename(path.join(root, "lib"), path.join(root, "vendor")); // folder rename
    await fs.chmod(path.join(root, "script.sh"), 0o755); // metadata
    await fs.rm(path.join(root, "gone.txt")); // removed
    await fs.rm(path.join(root, "becomes-dir"));
    await write("becomes-dir/inside.txt", "x"); // type change
    await fs.rm(path.join(root, "link"));
    await fs.symlink("src", path.join(root, "link")); // symlink retargeted

    const after = await buildSnapshot(root);
    const r = diff(before, after);

    expect(r.added.map((e) => e.path)).toEqual(["becomes-dir/inside.txt", "src/new", "src/new/feature.ts"]);
    expect(r.removed.map((e) => e.path)).toEqual(["gone.txt"]);
    expect(r.modified.map((e) => e.path)).toEqual(["link", "src/index.ts"]);
    expect(r.typeChanged).toEqual([{ path: "becomes-dir", before: "file", after: "directory" }]);
    expect(r.moved).toEqual([
      { from: "lib", to: "vendor", type: "directory", changes: [] },
      { from: "old-name.txt", to: "new-name.txt", type: "file", changes: [] },
    ]);
    if (isPosix) {
      expect(r.metadataChanged).toEqual([
        { path: "script.sh", type: "file", changes: [{ field: "mode", before: 0o644, after: 0o755 }] },
      ]);
    }
    expect(r.summary.total).toBe(r.added.length + r.removed.length + r.modified.length + r.typeChanged.length + r.moved.length + r.metadataChanged.length);
  });

  it("reports no changes and prunes at the root when nothing changed", async () => {
    await write("a/b/c.txt", "c");
    const one = await buildSnapshot(root);
    const two = await buildSnapshot(root);
    const r = diff(one, two);
    expect(r.summary.total).toBe(0);
    expect(r.stats.visitedNodes).toBe(1);
  });

  it("survives a save to disk and a later comparison", async () => {
    await write("a.txt", "1");
    const file = path.join(root, "..", `${path.basename(root)}.snap.json`);
    await fs.writeFile(file, serialize(await buildSnapshot(root)));
    try {
      await write("a.txt", "2");
      const before = deserialize(await fs.readFile(file, "utf8"));
      const r = diff(before, await buildSnapshot(root));
      expect(r.modified.map((e) => e.path)).toEqual(["a.txt"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("does not follow symlinks, including ones pointing outside the root or dangling", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fsdiff-outside-"));
    try {
      await write("outside-contents.txt", "x");
      await fs.writeFile(path.join(outside, "secret.txt"), "should not be read");
      await fs.symlink(outside, path.join(root, "to-outside"));
      await fs.symlink("does-not-exist", path.join(root, "dangling"));
      await fs.symlink(".", path.join(root, "loop"));
      const snap = await buildSnapshot(root);
      expect(snap.errors).toEqual([]);
      expect(snap.root.children.map((c) => [c.name, c.type])).toEqual([
        ["dangling", "symlink"],
        ["loop", "symlink"],
        ["outside-contents.txt", "file"],
        ["to-outside", "symlink"],
      ]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("skips ignored names and paths entirely", async () => {
    await write("node_modules/pkg/index.js", "x");
    await write("sub/node_modules/x.js", "x");
    await write(".git/HEAD", "ref");
    await write("debug.log", "log");
    await write("build/cache/x", "x");
    await write("build/out.js", "x");
    await write("src/a.ts", "a");
    const snap = await buildSnapshot(root, { ignore: ["node_modules", ".git", "*.log", "build/cache"] });
    const json = JSON.stringify(snap.root);
    expect(json).not.toMatch(/node_modules|\.git|debug\.log|cache/);
    expect(json).toContain("out.js");
    expect(snap.options.ignore).toEqual(["node_modules", ".git", "*.log", "build/cache"]);
  });

  it("hashes contents with streaming and matches an in-memory SHA-256", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 123, "abc");
    await write("big.bin", big);
    const expected = createHash("sha256").update(big).digest("hex");
    expect(await hashFile(path.join(root, "big.bin"))).toBe(expected);
    const snap = await buildSnapshot(root);
    expect((snap.root.children[0] as FileNode).contentHash).toBe(expected);
    expect((snap.root.children[0] as FileNode).size).toBe(big.length);
  });

  it("fast mode uses size + mtime, so a touch looks like a change; full hashing does not", async () => {
    await write("a.txt", "same");
    const fastBefore = await buildSnapshot(root, { fast: true });
    const fullBefore = await buildSnapshot(root);
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(path.join(root, "a.txt"), later, later);

    expect(diff(fastBefore, await buildSnapshot(root, { fast: true })).modified.map((e) => e.path)).toEqual(["a.txt"]);
    // Both full snapshots straddle the same touch: the content is the same, so nothing changed.
    const full = diff(fullBefore, await buildSnapshot(root));
    expect(full.summary.total).toBe(0);
    // The mtime did change, and is reported when asked for.
    expect(diff(fullBefore, await buildSnapshot(root), { compareMtime: true }).metadataChanged).toEqual([
      expect.objectContaining({ path: "a.txt", changes: [expect.objectContaining({ field: "mtimeMs" })] }),
    ]);
  });

  it.skipIf(isRoot || !isPosix)("records an unreadable file as an error and does not report it as removed", async () => {
    await write("ok.txt", "ok");
    await write("secret.txt", "secret");
    const before = await buildSnapshot(root);

    await lock(path.join(root, "secret.txt"));
    const after = await buildSnapshot(root);
    // lstat works on a mode-000 file; opening it to hash fails.
    expect(after.errors).toEqual([{ path: "secret.txt", kind: "unreadable", code: "EACCES", message: expect.stringMatching(/EACCES/) }]);
    expect(after.root.children.map((c) => c.name)).toEqual(["ok.txt"]);

    const r = diff(before, after);
    expect(r.summary.total).toBe(0);
    expect(r.stats.skippedUnreadable).toBe(1);
    expect(r.warnings).toEqual([expect.stringMatching(/^1 path\(s\) could not be read in the after snapshot/)]);
  });

  it("snapshots and diffs empty folders on disk", async () => {
    await fs.mkdir(path.join(root, "empty"));
    await fs.mkdir(path.join(root, "nested/also-empty"), { recursive: true });
    const before = await buildSnapshot(root);
    expect(before.root.children).toEqual([
      expect.objectContaining({ type: "directory", name: "empty", children: [] }),
      expect.objectContaining({ type: "directory", name: "nested", children: [expect.objectContaining({ name: "also-empty", children: [] })] }),
    ]);

    // Renaming an empty folder is an add + remove, never a guessed move; a new empty folder is added.
    await fs.rename(path.join(root, "empty"), path.join(root, "renamed"));
    await fs.mkdir(path.join(root, "nested/new-empty"));
    const r = diff(before, await buildSnapshot(root));
    expect(r.moved).toEqual([]);
    expect(r.removed).toEqual([{ path: "empty", type: "directory" }]);
    expect(r.added).toEqual([
      { path: "nested/new-empty", type: "directory" },
      { path: "renamed", type: "directory" },
    ]);
  });

  it.skipIf(isRoot || !isPosix)("records unreadable folders as errors instead of crashing", async () => {
    await write("ok.txt", "ok");
    await write("locked/inner.txt", "secret");
    const before = await buildSnapshot(root);

    await lock(path.join(root, "locked"));
    const after = await buildSnapshot(root);
    expect(after.errors).toEqual([expect.objectContaining({ path: "locked", code: "EACCES" })]);
    expect(after.root.children.map((c) => c.name)).toEqual(["ok.txt"]);

    // The unreadable folder is not misreported as removed.
    const r = diff(before, after);
    expect(r.removed).toEqual([]);
    expect(r.stats.skippedUnreadable).toBe(1);
    expect(r.warnings).toHaveLength(1);
  });

  it.skipIf(!isPosix)("skips FIFOs without blocking on them", async () => {
    await write("normal.txt", "x");
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    const snap = await buildSnapshot(root);
    expect(snap.root.children.map((c) => c.name)).toEqual(["normal.txt"]);
    expect(snap.errors).toEqual([
      expect.objectContaining({ path: "pipe", kind: "unsupported", message: expect.stringMatching(/unsupported/) }),
    ]);
  });

  it.skipIf(!isPosix)("reports a FIFO that was replaced by a regular file as added", async () => {
    execFileSync("mkfifo", [path.join(root, "p")]);
    const before = await buildSnapshot(root);
    await fs.rm(path.join(root, "p"));
    await write("p", "regular now");
    const r = diff(before, await buildSnapshot(root));
    expect(r.added).toEqual([{ path: "p", type: "file" }]);
  });

  it("handles unicode file names on disk", async () => {
    await write("日本語/über 🌍.txt", "x");
    const before = await buildSnapshot(root);
    await fs.rename(path.join(root, "日本語/über 🌍.txt"), path.join(root, "日本語/ünder 🌙.txt"));
    const r = diff(before, await buildSnapshot(root));
    expect(r.moved).toEqual([{ from: "日本語/über 🌍.txt", to: "日本語/ünder 🌙.txt", type: "file", changes: [] }]);
  });

  it.skipIf(isRoot || !isPosix)("rejects an unreadable root instead of returning an empty snapshot", async () => {
    await write("a.txt", "x");
    await lock(root);
    await expect(buildSnapshot(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it.skipIf(isRoot || !isPosix)("cleans up after locking a folder with any name", async () => {
    await write("other-name/deep/f.txt", "x");
    await lock(path.join(root, "other-name", "deep"));
    await lock(path.join(root, "other-name"));
    const snap = await buildSnapshot(root);
    expect(snap.errors.map((e) => e.path)).toEqual(["other-name"]);
    // afterEach must still be able to delete root; the next test would fail on a leftover mkdtemp otherwise.
  });

  it("rejects a root that is missing or not a directory", async () => {
    await write("f.txt", "x");
    await expect(buildSnapshot(path.join(root, "nope"))).rejects.toThrow(/ENOENT/);
    await expect(buildSnapshot(path.join(root, "f.txt"))).rejects.toThrow(/not a directory/);
  });
});

describe("file names that are not valid UTF-8", () => {
  const invalidName = (escapedPath: string) => ({
    path: escapedPath,
    kind: "invalidName",
    message: "file name is not valid UTF-8; skipped",
  });

  /**
   * Creates a file whose name is `dir/` + the given raw bytes. Skips the test
   * where such names can't exist: macOS and Windows reject them, and so do
   * UTF-8-only Linux file systems (ZFS utf8only, some FUSE/CIFS mounts).
   */
  async function writeRaw(ctx: { skip: (note?: string) => never }, dir: string, name: number[]): Promise<void> {
    if (process.platform !== "linux") ctx.skip("Linux only: other platforms reject file names that are not valid UTF-8");
    await fs.mkdir(path.join(root, dir), { recursive: true });
    const target = Buffer.concat([Buffer.from(`${path.join(root, dir)}/`), Buffer.from(name)]);
    try {
      await fs.writeFile(target, "x");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EILSEQ" || code === "EINVAL") ctx.skip(`the temp file system rejects invalid UTF-8 names (${code})`);
      throw err;
    }
  }
  const a = (...rest: number[]) => [0x61, ...rest]; // "a" followed by raw bytes

  it("records one in a subfolder without lstat-ing it, and keeps its siblings", async (ctx) => {
    await write("sub/ok.txt", "x");
    await writeRaw(ctx, "sub", a(0xff));
    const snap = await buildSnapshot(root);
    expect(snap.errors).toEqual([invalidName("sub/a\\xFF")]);
    const sub = snap.root.children[0];
    expect(sub?.type === "directory" && sub.children.map((c) => c.name)).toEqual(["ok.txt"]);
    expect(deserialize(serialize(snap))).toEqual(snap);
  });

  it("records one directly in the root", async (ctx) => {
    await writeRaw(ctx, ".", a(0xff));
    const snap = await buildSnapshot(root);
    expect(snap.root.children).toEqual([]);
    expect(snap.errors).toEqual([invalidName("a\\xFF")]);
  });

  it("keeps a valid name containing U+FFFD next to an invalid name that would decode to it", async (ctx) => {
    await writeRaw(ctx, "sub", a(0xff));
    await write("sub/a\uFFFD", "real");
    const snap = await buildSnapshot(root);
    const sub = snap.root.children[0];
    expect(sub?.type === "directory" && sub.children.map((c) => c.name)).toEqual(["a\uFFFD"]);
    expect(snap.errors).toEqual([invalidName("sub/a\\xFF")]);
  });

  it("gives two different invalid names two different paths", async (ctx) => {
    await writeRaw(ctx, ".", a(0xff));
    await writeRaw(ctx, ".", a(0xfe));
    await writeRaw(ctx, ".", [0x5c, 0xc3]); // a backslash and a truncated "é"
    const snap = await buildSnapshot(root);
    expect(snap.errors.map((e) => e.path)).toEqual(["\\\\\\xC3", "a\\xFE", "a\\xFF"]);
  });

  it("does not report an invalid name created between scans as added", async (ctx) => {
    await write("ok.txt", "x");
    const before = await buildSnapshot(root);
    await writeRaw(ctx, ".", a(0xff));
    const r = diff(before, await buildSnapshot(root));
    expect(r.added).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) could not be read in the after snapshot/)]);
  });
});

describe("symlink targets that are not valid UTF-8", () => {
  /** Creates symlink `name` whose target is the given raw bytes; skips where that can't exist (see writeRaw above). */
  async function linkRaw(ctx: { skip: (note?: string) => never }, name: string, target: number[]): Promise<void> {
    if (process.platform !== "linux") ctx.skip("Linux only: other platforms reject symlink targets that are not valid UTF-8");
    const link = path.join(root, name);
    await fs.rm(link, { force: true });
    try {
      await fs.symlink(Buffer.from(target), link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EILSEQ" || code === "EINVAL") ctx.skip(`the temp file system rejects invalid UTF-8 targets (${code})`);
      throw err;
    }
  }

  it("records the escaped target, marked as escaped, and diffs it", async (ctx) => {
    await linkRaw(ctx, "l", [0x61, 0xff]);
    const before = await buildSnapshot(root);
    expect(before.root.children).toEqual([{ type: "symlink", name: "l", target: "a\\xFF", targetEscaped: true }]);
    expect(deserialize(serialize(before))).toEqual(before);

    // Another invalid target is a change.
    await linkRaw(ctx, "l", [0x61, 0xfe]);
    const other = await buildSnapshot(root);
    expect(diff(before, other).modified.map((e) => e.path)).toEqual(["l"]);

    // So is a real target that literally reads `a\xFF`.
    await fs.rm(path.join(root, "l"));
    await fs.symlink("a\\xFF", path.join(root, "l"));
    const literal = await buildSnapshot(root);
    expect(literal.root.children).toEqual([{ type: "symlink", name: "l", target: "a\\xFF" }]);
    expect(diff(before, literal).modified.map((e) => e.path)).toEqual(["l"]);

    // And the same invalid target again is not.
    await linkRaw(ctx, "l", [0x61, 0xff]);
    expect(diff(before, await buildSnapshot(root)).summary.total).toBe(0);
  });
});
