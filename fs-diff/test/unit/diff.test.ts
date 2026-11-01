import { describe, expect, it } from "vitest";
import { diff, type DiffResult } from "../../src/diff.js";
import { formatReport } from "../../src/report.js";
import { directory, file, fromObject, symlink, type TreeSpec } from "../../src/snapshot.js";

/** Diffs two in-memory trees. */
const run = (before: TreeSpec, after: TreeSpec, options = {}): DiffResult =>
  diff(fromObject(before), fromObject(after), options);

/** Only the change lists, for compact assertions. */
const changes = (r: DiffResult) => ({
  added: r.added.map((e) => e.path),
  removed: r.removed.map((e) => e.path),
  modified: r.modified.map((e) => e.path),
  metadataChanged: r.metadataChanged.map((e) => e.path),
  typeChanged: r.typeChanged.map((e) => `${e.path}:${e.before}->${e.after}`),
  moved: r.moved.map((e) => `${e.from}->${e.to}`),
});

const none = { added: [], removed: [], modified: [], metadataChanged: [], typeChanged: [], moved: [] };

describe("diff", () => {
  it("reports nothing for identical trees and visits only the root", () => {
    const tree = { a: "1", src: { b: "2", deep: { c: "3" } } };
    const r = run(tree, tree);
    expect(changes(r)).toEqual(none);
    expect(r.summary.total).toBe(0);
    expect(r.stats).toEqual({ visitedNodes: 1, prunedSubtrees: 1, skippedUnreadable: 0 });
  });

  it("reports additions at different depths, including every path inside a new folder", () => {
    const r = run({ a: "1", src: {} }, { a: "1", top: "x", src: { mid: "y", lib: { deep: "z" } } });
    expect(changes(r)).toEqual({ ...none, added: ["src/lib", "src/lib/deep", "src/mid", "top"] });
    expect(r.added.find((e) => e.path === "src/lib")?.type).toBe("directory");
  });

  it("reports removals at different depths", () => {
    const r = run({ a: "1", b: { c: "2", d: { e: "3" } } }, { b: { c: "2", d: {} } });
    expect(changes(r)).toEqual({ ...none, removed: ["a", "b/d/e"] });
  });

  it("reports content modifications at different depths", () => {
    const r = run({ a: "1", b: { c: { d: "2" } } }, { a: "one", b: { c: { d: "two" } } });
    expect(changes(r)).toEqual({ ...none, modified: ["a", "b/c/d"] });
    const [a] = r.modified;
    expect(a?.before.type === "file" && a.before.size).toBe(1);
    expect(a?.after.type === "file" && a.after.size).toBe(3);
  });

  it("reports a symlink target change as modified", () => {
    const r = run({ l: symlink("a") }, { l: symlink("b") });
    expect(changes(r)).toEqual({ ...none, modified: ["l"] });
  });

  it("reports mode changes as metadataChanged, and ignores mtime unless asked", () => {
    const before = { run: file("x", { mode: 0o644, mtimeMs: 1 }), touched: file("y", { mtimeMs: 1 }) };
    const after = { run: file("x", { mode: 0o755, mtimeMs: 1 }), touched: file("y", { mtimeMs: 2 }) };
    const r = run(before, after);
    expect(changes(r)).toEqual({ ...none, metadataChanged: ["run"] });
    expect(r.metadataChanged[0]?.changes).toEqual([{ field: "mode", before: 0o644, after: 0o755 }]);

    const withMtime = run(before, after, { compareMtime: true });
    expect(changes(withMtime).metadataChanged).toEqual(["run", "touched"]);
  });

  it("reports a content change as modified, not metadataChanged, even if the mode also changed", () => {
    const r = run({ f: file("a", { mode: 0o644 }) }, { f: file("b", { mode: 0o755 }) });
    expect(changes(r)).toEqual({ ...none, modified: ["f"] });
  });

  it("reports type changes and treats a replaced folder's contents as removed", () => {
    const r = run({ x: "file", y: { inner: "1" }, z: symlink("x") }, { x: { now: "dir" }, y: "file", z: "real" });
    expect(changes(r)).toEqual({
      ...none,
      typeChanged: ["x:file->directory", "y:directory->file", "z:symlink->file"],
      added: ["x/now"],
      removed: ["y/inner"],
    });
  });

  it("detects a file rename/move as a move rather than add + remove", () => {
    const r = run({ docs: { "old.md": "content" } }, { docs: {}, archive: { "new.md": "content" } });
    expect(changes(r)).toEqual({ ...none, added: ["archive"], moved: ["docs/old.md->archive/new.md"] });
  });

  it("detects a whole folder rename as a single move", () => {
    const folder = { "a.ts": "a", "b.ts": "b", nested: { "c.ts": "c" } };
    const r = run({ src: { old: folder } }, { src: { renamed: folder } });
    expect(changes(r)).toEqual({ ...none, moved: ["src/old->src/renamed"] });
    expect(r.moved[0]?.type).toBe("directory");
  });

  it("falls back to per-file moves when a renamed folder also had a file changed", () => {
    const r = run({ old: { a: "a", b: "b" } }, { new: { a: "a", b: "B!" } });
    expect(changes(r)).toEqual({
      ...none,
      added: ["new", "new/b"],
      removed: ["old", "old/b"],
      moved: ["old/a->new/a"],
    });
  });

  it("detects a subfolder moved out of a removed folder", () => {
    const r = run({ gone: { keep: { x: "1", y: "2" }, trash: "t" } }, { kept: { x: "1", y: "2" } });
    expect(changes(r)).toEqual({ ...none, removed: ["gone", "gone/trash"], moved: ["gone/keep->kept"] });
  });

  it("does not guess when the same content appears more than once", () => {
    const twoSources = run({ a: "same", b: "same" }, { c: "same" });
    expect(changes(twoSources)).toEqual({ ...none, added: ["c"], removed: ["a", "b"] });
    const twoTargets = run({ a: "same" }, { b: "same", c: "same" });
    expect(changes(twoTargets)).toEqual({ ...none, added: ["b", "c"], removed: ["a"] });
  });

  it("treats a copy (original still present) as an add, not a move", () => {
    const r = run({ a: "data" }, { a: "data", b: "data" });
    expect(changes(r)).toEqual({ ...none, added: ["b"] });
  });

  it("never matches empty files or empty folders as moves", () => {
    const r = run({ "e.txt": "", d: {} }, { "f.txt": "", g: {} });
    expect(changes(r)).toEqual({ ...none, added: ["f.txt", "g"], removed: ["d", "e.txt"] });
  });

  it("compares empty folders and empty files like any other node", () => {
    expect(changes(run({ d: {}, e: "" }, { d: {}, e: "" }))).toEqual(none);
    expect(changes(run({ e: "" }, { e: "now has content" }))).toEqual({ ...none, modified: ["e"] });
  });

  it("can turn move detection off", () => {
    const r = run({ a: "x" }, { b: "x" }, { detectMoves: false });
    expect(changes(r)).toEqual({ ...none, added: ["b"], removed: ["a"] });
  });

  it("handles unicode names, case-sensitively and without normalization", () => {
    const nfc = "café";
    const nfd = "café";
    const r = run({ "日本語": { "über.txt": "1" }, "Readme.md": "r", [nfc]: "c" }, {
      "日本語": { "über.txt": "2", "🌍.txt": "w" },
      "README.md": "r!",
      [nfd]: "c!",
    });
    expect(changes(r)).toEqual({
      ...none,
      added: ["README.md", nfd, "日本語/🌍.txt"],
      removed: ["Readme.md", nfc],
      modified: ["日本語/über.txt"],
    });
  });

  it("returns every list sorted by path and a summary that matches", () => {
    const r = run({ z: "1", a: "1x", m: { q: "1y" } }, { y: "2", b: "3", m: { a: "4" } });
    expect(r.added.map((e) => e.path)).toEqual(["b", "m/a", "y"]);
    expect(r.removed.map((e) => e.path)).toEqual(["a", "m/q", "z"]);
    expect(r.summary).toEqual({ added: 3, removed: 3, modified: 0, metadataChanged: 0, typeChanged: 0, moved: 0, total: 6 });
  });

  it("reports a directory mode change", () => {
    const r = run({ d: directory({ f: "1" }, { mode: 0o755 }) }, { d: directory({ f: "1" }, { mode: 0o700 }) });
    expect(changes(r)).toEqual({ ...none, metadataChanged: ["d"] });
    expect(r.metadataChanged[0]).toEqual({
      path: "d",
      type: "directory",
      changes: [{ field: "mode", before: 0o755, after: 0o700 }],
    });
  });

  it("refuses to compare a fast snapshot with a full one", () => {
    expect(() => diff(fromObject({ a: "1" }, { fast: true }), fromObject({ a: "1" }))).toThrow(/fast/);
  });

  it("does not report paths that were unreadable in one of the snapshots", () => {
    const before = fromObject({ ok: "1", secret: { s: "x" } });
    const after = fromObject({ ok: "1" });
    after.errors.push({ path: "secret", kind: "unreadable", code: "EACCES", message: "permission denied" });
    const r = diff(before, after);
    expect(changes(r)).toEqual(none);
    expect(r.stats.skippedUnreadable).toBe(1);
    expect(r.warnings.join()).toMatch(/could not be read in the after snapshot/);
  });

  it("treats EPERM like EACCES", () => {
    const before = fromObject({ secret: "x" });
    const after = fromObject({});
    after.errors.push({ path: "secret", kind: "unreadable", code: "EPERM", message: "operation not permitted" });
    expect(changes(diff(before, after))).toEqual(none);
  });

  describe("error kinds", () => {
    const unsupported = { path: "p", kind: "unsupported", message: "unsupported file type (socket, FIFO or device); skipped" } as const;
    const eio = (p: string) => ({ path: p, kind: "unreadable", code: "EIO", message: "i/o error" }) as const;

    it("reports a FIFO that became a regular file as added", () => {
      const before = fromObject({});
      before.errors.push(unsupported);
      const r = diff(before, fromObject({ p: "now a file" }));
      expect(changes(r)).toEqual({ ...none, added: ["p"] });
      expect(r.stats.skippedUnreadable).toBe(0);
      expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) in the before snapshot are sockets, FIFOs or devices/)]);
    });

    it("reports a regular file that became a FIFO as removed", () => {
      const after = fromObject({});
      after.errors.push(unsupported);
      const r = diff(fromObject({ p: "was a file" }), after);
      expect(changes(r)).toEqual({ ...none, removed: ["p"] });
      expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) in the after snapshot are sockets, FIFOs or devices/)]);
    });

    it("does not report an I/O error in after as a removal, at any depth", () => {
      const after = fromObject({});
      after.errors.push(eio("d"));
      const r = diff(fromObject({ d: { f: "1" } }), after);
      expect(changes(r)).toEqual(none);
      expect(r.stats.skippedUnreadable).toBe(1);
      expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) could not be read in the after snapshot/)]);
    });

    it("does not report an I/O error in before as an addition", () => {
      const before = fromObject({});
      before.errors.push(eio("f.txt"));
      const r = diff(before, fromObject({ "f.txt": "1" }));
      expect(changes(r)).toEqual(none);
      expect(r.stats.skippedUnreadable).toBe(1);
      expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) could not be read in the before snapshot/)]);
    });

    it("never uses an unreadable path as a move source", () => {
      // f.txt is still there but unreadable in after; copy.txt is a new copy of it.
      const after = fromObject({ "copy.txt": "same content" });
      after.errors.push(eio("f.txt"));
      const r = diff(fromObject({ "f.txt": "same content" }), after);
      expect(changes(r)).toEqual({ ...none, added: ["copy.txt"] });
    });

    it("never uses an unreadable path as a move target", () => {
      const before = fromObject({ "copy.txt": "same content" });
      before.errors.push(eio("f.txt"));
      const r = diff(before, fromObject({ "f.txt": "same content" }));
      expect(changes(r)).toEqual({ ...none, removed: ["copy.txt"] });
    });

    it("treats an invalid name like an unreadable path", () => {
      const after = fromObject({});
      after.errors.push({ path: "a\\xFF", kind: "invalidName", message: "file name is not valid UTF-8; skipped" });
      const r = diff(fromObject({}), after);
      expect(changes(r)).toEqual(none);
      expect(r.warnings).toEqual([expect.stringMatching(/1 path\(s\) could not be read in the after snapshot/)]);
    });

    it("handles every kind in one diff", () => {
      const before = fromObject({ fifo: "was a file", io: "x", locked: { s: "1" }, gone: "g", same: "s" });
      before.errors.push({ path: "pipe", kind: "unsupported", message: "unsupported" });
      const after = fromObject({ pipe: "now a file", same: "s", fresh: "n" });
      after.errors.push(
        { path: "fifo", kind: "unsupported", message: "unsupported" },
        eio("io"),
        { path: "locked", kind: "unreadable", code: "EACCES", message: "denied" },
        { path: "bad\\xFF", kind: "invalidName", message: "file name is not valid UTF-8; skipped" },
      );
      const r = diff(before, after);
      expect(changes(r)).toEqual({ ...none, added: ["fresh", "pipe"], removed: ["fifo", "gone"] });
      expect(r.stats.skippedUnreadable).toBe(2);
      expect(r.warnings).toEqual([
        expect.stringMatching(/^1 path\(s\) in the before snapshot are sockets/),
        expect.stringMatching(/^3 path\(s\) could not be read in the after snapshot/),
        expect.stringMatching(/^1 path\(s\) in the after snapshot are sockets/),
      ]);
    });
  });
});

describe("symlink targets that are not valid UTF-8", () => {
  const raw = (...bytes: number[]) => symlink(Uint8Array.of(...bytes));

  it("detects a change from one invalid target to another", () => {
    const r = run({ l: raw(0x61, 0xff) }, { l: raw(0x61, 0xfe) });
    expect(changes(r)).toEqual({ ...none, modified: ["l"] });
  });

  it("does not confuse an escaped target with a real target that reads the same text", () => {
    const r = run({ l: raw(0x61, 0xff) }, { l: symlink("a\\xFF") });
    expect(changes(r)).toEqual({ ...none, modified: ["l"] });
    expect(fromObject({ d: { l: raw(0x61, 0xff) } }).root.hash).not.toBe(fromObject({ d: { l: symlink("a\\xFF") } }).root.hash);
  });

  it("still detects a rename of a link with an escaped target as a move", () => {
    expect(changes(run({ a: raw(0xff) }, { b: raw(0xff) }))).toEqual({ ...none, moved: ["a->b"] });
  });
});

describe("Merkle pruning", () => {
  /** A complete tree: `fanout` sub-directories per level and `fanout` files in each directory. */
  function tree(depth: number, fanout: number, changedPath: string[] = [], prefix = ""): TreeSpec {
    const spec: TreeSpec = {};
    for (let i = 0; i < fanout; i++) {
      const name = `f${i}`;
      const isTarget = changedPath.length === 1 && changedPath[0] === name;
      spec[name] = isTarget ? "CHANGED" : `${prefix}/${name}`;
      if (depth > 0) {
        const dir = `d${i}`;
        const rest = changedPath[0] === dir ? changedPath.slice(1) : [];
        spec[dir] = tree(depth - 1, fanout, rest, `${prefix}/${dir}`);
      }
    }
    return spec;
  }

  it("visits only the changed path's directories when one deep file changes", () => {
    const depth = 5;
    const fanout = 4;
    const before = fromObject(tree(depth, fanout));
    const after = fromObject(tree(depth, fanout, ["d1", "d2", "d3", "d0", "d1", "f2"]));

    let totalNodes = 0;
    const count = (n: { type: string; children?: unknown[] }): void => {
      totalNodes++;
      if (n.type === "directory") (n.children as typeof n[]).forEach(count);
    };
    count(before.root);

    const r = diff(before, after);
    expect(changes(r)).toEqual({ ...none, modified: ["d1/d2/d3/d0/d1/f2"] });
    // Root, plus every child of each directory on the changed path (2 * fanout per level, fewer at the leaf level).
    expect(r.stats.visitedNodes).toBe(1 + depth * 2 * fanout + fanout);
    expect(r.stats.visitedNodes).toBeLessThan(totalNodes / 50);
    expect(totalNodes).toBe(6825);

    // Without pruning (mtime comparison disables it) every node is visited.
    expect(diff(before, after, { compareMtime: true }).stats.visitedNodes).toBe(totalNodes);
  });
});

const moves = (before: TreeSpec, after: TreeSpec) => {
  const r = diff(fromObject(before), fromObject(after));
  return {
    moved: r.moved.map((m) => `${m.from}->${m.to}`),
    added: r.added.map((e) => e.path),
    removed: r.removed.map((e) => e.path),
  };
};

describe("root directory mode changes", () => {
  it("are reported, even though the root hash is unchanged", () => {
    const r = diff(fromObject({ a: "1" }, { rootMode: 0o755 }), fromObject({ a: "1" }, { rootMode: 0o700 }));
    expect(r.metadataChanged).toEqual([
      { path: ".", type: "directory", changes: [{ field: "mode", before: 0o755, after: 0o700 }] },
    ]);
    expect(r.summary.total).toBe(1);
    expect(formatReport(r)).toContain("~ ./  mode 0755 -> 0700");
  });

  it("are reported when pruning is off too", () => {
    const r = diff(fromObject({}, { rootMode: 0o755 }), fromObject({}, { rootMode: 0o700 }), { compareMtime: true });
    expect(r.metadataChanged.map((e) => e.path)).toEqual(["."]);
  });
});

describe("unreadable paths nested inside one-sided subtrees", () => {
  it("are skipped, not reported as removed", () => {
    const before = fromObject({ dir: { nested: { "secret.txt": "data", "ok.txt": "ok" } } });
    const after = fromObject({});
    after.errors.push({ path: "dir/nested/secret.txt", kind: "unreadable", code: "EACCES", message: "permission denied" });
    const r = diff(before, after);
    expect(r.removed.map((e) => e.path)).toEqual(["dir", "dir/nested", "dir/nested/ok.txt"]);
    expect(r.stats.skippedUnreadable).toBe(1);
  });

  it("skip their whole subtree when the unreadable path is a directory", () => {
    const before = fromObject({});
    before.errors.push({ path: "new/locked", kind: "unreadable", code: "EACCES", message: "permission denied" });
    const after = fromObject({ new: { locked: { a: "1", b: "2" }, open: "x" } });
    const r = diff(before, after);
    expect(r.added.map((e) => e.path)).toEqual(["new", "new/open"]);
    expect(r.stats.skippedUnreadable).toBe(1);
  });
});

describe("move index is kept up to date as moves consume subtrees", () => {
  const sub = { "file.txt": "content" };

  it("matches a standalone folder whose twin was consumed by a parent's move", () => {
    expect(moves({ parent1: { sub }, standalone_sub: sub }, { parent1_moved: { sub }, standalone_sub_moved: sub })).toEqual({
      moved: ["parent1->parent1_moved", "standalone_sub->standalone_sub_moved"],
      added: [],
      removed: [],
    });
  });

  it("gives the same answer when the standalone folder sorts before the parent", () => {
    expect(moves({ zparent: { sub }, aaa_sub: sub }, { zparent_moved: { sub }, aaa_sub_moved: sub })).toEqual({
      moved: ["aaa_sub->aaa_sub_moved", "zparent->zparent_moved"],
      added: [],
      removed: [],
    });
  });

  it("matches a file whose twin was consumed by a folder move", () => {
    expect(moves({ dir: { "a.txt": "same", b: "b" }, "a.txt": "same" }, { dir2: { "a.txt": "same", b: "b" }, "c.txt": "same" })).toEqual({
      moved: ["a.txt->c.txt", "dir->dir2"],
      added: [],
      removed: [],
    });
  });

  it("still refuses to guess when duplicates remain", () => {
    expect(moves({ a: sub, b: sub }, { c: sub, d: sub })).toEqual({
      moved: [],
      added: ["c", "c/file.txt", "d", "d/file.txt"],
      removed: ["a", "a/file.txt", "b", "b/file.txt"],
    });
  });
});

describe("a move that also changed metadata", () => {
  it("keeps the mode change on the move entry", () => {
    const r = diff(fromObject({ "old.txt": file("hello", { mode: 0o644 }) }), fromObject({ "new.txt": file("hello", { mode: 0o755 }) }));
    expect(r.moved).toEqual([
      { from: "old.txt", to: "new.txt", type: "file", changes: [{ field: "mode", before: 0o644, after: 0o755 }] },
    ]);
    expect(formatReport(r)).toContain("> old.txt -> new.txt  mode 0644 -> 0755");
  });

  it("keeps a renamed folder's own mode change", () => {
    const r = diff(
      fromObject({ a: directory({ f: "1" }, { mode: 0o755 }) }),
      fromObject({ b: directory({ f: "1" }, { mode: 0o700 }) }),
    );
    expect(r.moved).toEqual([
      { from: "a", to: "b", type: "directory", changes: [{ field: "mode", before: 0o755, after: 0o700 }] },
    ]);
  });

  it("has an empty change list for a plain move", () => {
    const r = diff(fromObject({ a: "x" }), fromObject({ b: "x" }));
    expect(r.moved[0]?.changes).toEqual([]);
  });
});

describe("ignore lists in a different order", () => {
  it("do not produce a warning", () => {
    const one = fromObject({ a: "1" });
    one.options.ignore = ["node_modules", ".git"];
    const two = fromObject({ a: "1" });
    two.options.ignore = [".git", "node_modules"];
    expect(diff(one, two).warnings).toEqual([]);
    two.options.ignore = [".git"];
    expect(diff(one, two).warnings).toHaveLength(1);
  });
});

describe("cases the main tests don't reach", () => {
  it("leaves an unchanged symlink alone when a sibling changed (its folder is not pruned)", () => {
    expect(changes(run({ l: symlink("t"), f: "1" }, { l: symlink("t"), f: "2" }))).toEqual({ ...none, modified: ["f"] });
  });

  it("moves a folder whose old path held an unreadable entry, without reporting that entry", () => {
    const after = fromObject({ b: { f: "1", s: "2" } });
    after.errors.push({ path: "a/s", kind: "unreadable", code: "EIO", message: "i/o error" });
    // a keeps its recorded hash, so it still matches b as one move; a/s was never collected.
    const r = diff(fromObject({ a: { f: "1", s: "2" } }), after);
    expect(changes(r)).toEqual({ ...none, moved: ["a->b"] });
    expect(r.stats.skippedUnreadable).toBe(1);
  });

  it("moves a folder that contains an empty file, consuming the empty file too", () => {
    expect(changes(run({ a: { empty: "", f: "1" } }, { b: { empty: "", f: "1" } }))).toEqual({ ...none, moved: ["a->b"] });
  });
});
