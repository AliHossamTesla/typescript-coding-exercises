/**
 * Entries that disappear while the scan is running (deleted mid-scan), and
 * entries that fail to read for other reasons.
 *
 * `lstat` and `stat` are wrapped so each race is deterministic: a hook either
 * fails the call with a given code, or runs right after the real call and
 * really deletes the entry, so the next fs call on it (readdir, readlink,
 * opening for hashing) hits a real ENOENT.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Hook = (target: string) => Promise<void>;

const hooks = vi.hoisted(() => ({
  /** Base names whose lstat should fail, mapped to the error code to fail with. */
  lstatFails: new Map<string, string>(),
  /** Base names with a side effect to run right after a successful lstat. */
  afterLstat: new Map<string, Hook>(),
  /** Base names with a side effect to run right after a successful stat (used on the root). */
  afterStat: new Map<string, Hook>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: vi.fn(async (target: string) => {
      const code = hooks.lstatFails.get(path.basename(target));
      if (code !== undefined) throw Object.assign(new Error(`${code}: mocked, lstat '${target}'`), { code });
      const stat = await real.lstat(target);
      await hooks.afterLstat.get(path.basename(target))?.(target);
      return stat;
    }),
    stat: vi.fn(async (target: string) => {
      const stat = await real.stat(target);
      await hooks.afterStat.get(path.basename(target))?.(target);
      return stat;
    }),
  };
});

const { buildSnapshot } = await import("../../src/snapshot.js");
const { diff } = await import("../../src/diff.js");

const remove: Hook = (target) => fs.rm(target, { recursive: true, force: true });

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fsdiff-vanish-"));
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  await fs.writeFile(path.join(root, "gone.txt"), "gone");
});

afterEach(async () => {
  hooks.lstatFails.clear();
  hooks.afterLstat.clear();
  hooks.afterStat.clear();
  await fs.rm(root, { recursive: true, force: true });
});

/** Snapshots the tree before and after `arrange`, and returns the second snapshot and the diff. */
async function scanTwice(arrange: () => void) {
  const before = await buildSnapshot(root);
  arrange();
  const after = await buildSnapshot(root);
  return { after, result: diff(before, after) };
}

describe("an entry deleted during the scan is omitted without an error, so the diff reports a removal", () => {
  it.each(["ENOENT", "ENOTDIR"])("at lstat (%s)", async (code) => {
    const { after, result } = await scanTwice(() => hooks.lstatFails.set("gone.txt", code));
    expect(after.errors).toEqual([]);
    expect(after.root.children.map((c) => c.name)).toEqual(["keep.txt"]);
    expect(result.removed).toEqual([{ path: "gone.txt", type: "file" }]);
    expect(result.stats.skippedUnreadable).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("between lstat and opening the file for hashing", async () => {
    const { after, result } = await scanTwice(() => hooks.afterLstat.set("gone.txt", remove));
    expect(after.errors).toEqual([]);
    expect(result.removed).toEqual([{ path: "gone.txt", type: "file" }]);
    expect(result.warnings).toEqual([]);
  });

  it("a folder between its lstat and its readdir", async () => {
    await fs.mkdir(path.join(root, "d"));
    await fs.writeFile(path.join(root, "d", "x"), "1");
    const { after, result } = await scanTwice(() => hooks.afterLstat.set("d", remove));
    expect(after.errors).toEqual([]);
    expect(after.root.children.map((c) => c.name)).toEqual(["gone.txt", "keep.txt"]);
    expect(result.removed.map((e) => e.path)).toEqual(["d", "d/x"]);
    expect(result.warnings).toEqual([]);
  });

  it("a folder after it was listed: its children vanish one by one and it stays as an empty folder", async () => {
    await fs.mkdir(path.join(root, "d"));
    await fs.writeFile(path.join(root, "d", "x"), "1");
    // Deleting d/x's parent after lstat of d/x: x itself vanishes, d was already listed.
    const { after, result } = await scanTwice(() => hooks.afterLstat.set("x", () => remove(path.join(root, "d"))));
    expect(after.errors).toEqual([]);
    expect(result.removed.map((e) => e.path)).toEqual(["d/x"]);
  });

  it("a symlink between lstat and readlink", async () => {
    await fs.symlink("keep.txt", path.join(root, "ln"));
    const { after, result } = await scanTwice(() => hooks.afterLstat.set("ln", remove));
    expect(after.errors).toEqual([]);
    expect(result.removed).toEqual([{ path: "ln", type: "symlink" }]);
  });

  it("a file whose name really contains U+FFFD, like any other name", async () => {
    await fs.writeFile(path.join(root, "bad�.txt"), "x");
    const { after, result } = await scanTwice(() => hooks.afterLstat.set("bad�.txt", remove));
    expect(after.errors).toEqual([]);
    expect(result.removed).toEqual([{ path: "bad�.txt", type: "file" }]);
    expect(result.warnings).toEqual([]);
  });
});

describe("an entry that exists but fails to read", () => {
  it("is recorded as unreadable and not reported as removed", async () => {
    const { after, result } = await scanTwice(() => hooks.lstatFails.set("gone.txt", "EIO"));
    expect(after.errors).toEqual([expect.objectContaining({ path: "gone.txt", kind: "unreadable", code: "EIO" })]);
    expect(result.removed).toEqual([]);
    expect(result.stats.skippedUnreadable).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/1 path\(s\) could not be read in the after snapshot/)]);
  });

  it("is not reported as a move to an identical new copy", async () => {
    const before = await buildSnapshot(root);
    await fs.copyFile(path.join(root, "gone.txt"), path.join(root, "copy.txt"));
    hooks.lstatFails.set("gone.txt", "EIO");
    const r = diff(before, await buildSnapshot(root));
    expect(r.moved).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.added).toEqual([{ path: "copy.txt", type: "file" }]);
  });
});

describe("the root", () => {
  it("throws a clear error when it is missing", async () => {
    const missing = path.join(root, "nope");
    await expect(buildSnapshot(missing)).rejects.toThrow(`ENOENT: no such file or directory, stat '${missing}'`);
  });

  it("throws a clear error when it is a file", async () => {
    const file = path.join(root, "keep.txt");
    await expect(buildSnapshot(file)).rejects.toThrow(`not a directory: ${file}`);
  });

  it("throws a clear error when it vanishes between stat and readdir", async () => {
    hooks.afterStat.set(path.basename(root), remove);
    await expect(buildSnapshot(root)).rejects.toThrow(`ENOENT: no such file or directory, scandir '${root}'`);
  });
});
