/**
 * Property tests: random trees and random mutations, checked against a naive
 * reference diff that flattens both trees to path maps (no Merkle pruning, no
 * move detection). The seed is fixed so runs are reproducible.
 *
 * To replay a failure, copy the seed and path fast-check prints:
 *   FC_SEED=<seed> FC_PATH="<path>" npx vitest run test/unit/diff.property.test.ts -t "<test name>"
 * FC_RUNS=<n> runs more cases.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diff, type DiffResult } from "../../src/diff.js";
import { directory, file, fromObject, symlink, type TreeSpec } from "../../src/snapshot.js";

/** A tree in a shape that is easy to generate, mutate and flatten independently of the code under test. */
type Tree = FileT | LinkT | DirT;
interface FileT {
  kind: "file";
  content: string;
  mode: number;
}
interface LinkT {
  kind: "link";
  target: string;
}
interface DirT {
  kind: "dir";
  mode: number;
  children: Record<string, Tree>;
}

// Small alphabets on purpose: they make equal names, equal contents and moves likely.
const NAMES = ["a", "b", "c", "d", "A", "é", "é", "a b", "z.txt"];
const nameArb = fc.constantFrom(...NAMES);
const contentArb = fc.constantFrom("", "1", "2", "same", "other content");
const fileModeArb = fc.constantFrom(0o644, 0o755, 0o600);
const dirModeArb = fc.constantFrom(0o755, 0o700);
const targetArb = fc.constantFrom("a", "../x", "b/c");

const { dir: dirArb } = fc.letrec<{ node: Tree; dir: DirT }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4, depthSize: "small" },
    fc.record({ kind: fc.constant("file" as const), content: contentArb, mode: fileModeArb }),
    fc.record({ kind: fc.constant("link" as const), target: targetArb }),
    tie("dir"),
  ),
  dir: fc.record({
    kind: fc.constant("dir" as const),
    mode: dirModeArb,
    children: fc.dictionary(nameArb, tie("node"), { maxKeys: 5, noNullPrototype: true }),
  }),
}));

/** One mutation of a tree. Indexes pick among the tree's current paths, modulo their count. */
type Mutation =
  | { op: "add"; at: number; name: string; node: Tree }
  | { op: "remove"; at: number }
  | { op: "edit"; at: number; content: string }
  | { op: "chmod"; at: number; mode: number }
  | { op: "rename"; at: number; to: number; name: string }
  | { op: "retarget"; at: number; target: string }
  | { op: "toDir"; at: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant("add" as const), at: fc.nat(), name: nameArb, node: dirArb }),
  fc.record({ op: fc.constant("add" as const), at: fc.nat(), name: nameArb, node: fc.record({ kind: fc.constant("file" as const), content: contentArb, mode: fileModeArb }) }),
  fc.record({ op: fc.constant("remove" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("edit" as const), at: fc.nat(), content: contentArb }),
  fc.record({ op: fc.constant("chmod" as const), at: fc.nat(), mode: fc.oneof(fileModeArb, dirModeArb) }),
  fc.record({ op: fc.constant("rename" as const), at: fc.nat(), to: fc.nat(), name: nameArb }),
  fc.record({ op: fc.constant("retarget" as const), at: fc.nat(), target: targetArb }),
  fc.record({ op: fc.constant("toDir" as const), at: fc.nat() }),
);

/** Every node with its parent and name, root first (the root has no parent). */
function entries(root: DirT): Array<{ parent: DirT | undefined; name: string; node: Tree }> {
  const out: Array<{ parent: DirT | undefined; name: string; node: Tree }> = [{ parent: undefined, name: "", node: root }];
  for (let i = 0; i < out.length; i++) {
    const { node } = out[i]!; // i < out.length
    if (node.kind === "dir") for (const [name, child] of Object.entries(node.children)) out.push({ parent: node, name, node: child });
  }
  return out;
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length]!; // callers pass non-empty lists
}

/** Applies a mutation in place. Mutations that don't fit the picked node do nothing. */
function mutate(root: DirT, m: Mutation): void {
  const all = entries(root);
  const dirs = all.flatMap((e) => (e.node.kind === "dir" ? [e.node] : []));
  const nonRoot = all.filter((e) => e.parent !== undefined);
  switch (m.op) {
    case "add": {
      const target = pick(dirs, m.at);
      if (!(m.name in target.children)) target.children[m.name] = structuredClone(m.node);
      return;
    }
    case "chmod": {
      const e = pick(all, m.at);
      if (e.node.kind !== "link") e.node.mode = m.mode;
      return;
    }
  }
  if (nonRoot.length === 0) return;
  const e = pick(nonRoot, m.at);
  const parent = e.parent!; // nonRoot entries all have a parent
  switch (m.op) {
    case "remove":
      delete parent.children[e.name];
      return;
    case "edit":
      if (e.node.kind === "file") e.node.content = m.content;
      return;
    case "retarget":
      if (e.node.kind === "link") e.node.target = m.target;
      return;
    case "toDir":
      if (e.node.kind !== "dir") parent.children[e.name] = { kind: "dir", mode: 0o755, children: { inner: { kind: "file", content: "x", mode: 0o644 } } };
      return;
    case "rename": {
      // Move into any directory that is not inside the moved node itself.
      const moved = new Set(entries(e.node.kind === "dir" ? e.node : { kind: "dir", mode: 0, children: {} }).map((x) => x.node));
      const targets = dirs.filter((d) => !moved.has(d));
      const into = pick(targets, m.to);
      if (m.name in into.children) return;
      delete parent.children[e.name];
      into.children[m.name] = e.node;
      return;
    }
  }
}

function toSpec(dir: DirT): TreeSpec {
  const spec: TreeSpec = {};
  for (const [name, node] of Object.entries(dir.children)) {
    spec[name] =
      node.kind === "file"
        ? file(node.content, { mode: node.mode })
        : node.kind === "link"
          ? symlink(node.target)
          : directory(toSpec(node), { mode: node.mode });
  }
  return spec;
}

/** Path -> node for every node below the root, with `/`-joined paths. */
function flatten(dir: DirT, prefix = "", out = new Map<string, Tree>()): Map<string, Tree> {
  for (const [name, node] of Object.entries(dir.children)) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    out.set(path, node);
    if (node.kind === "dir") flatten(node, path, out);
  }
  return out;
}

/** Only content that identifies a node can be matched as a move: non-empty files and folders, and symlinks. */
function isMoveCandidate(node: Tree): boolean {
  return node.kind === "file" ? node.content !== "" : node.kind === "dir" ? Object.keys(node.children).length > 0 : true;
}

const byCodeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The naive diff: compare every path, no pruning, no moves. Lists of paths, sorted. */
function referenceDiff(before: DirT, after: DirT) {
  const b = flatten(before);
  const a = flatten(after);
  const ref = { added: [] as string[], removed: [] as string[], modified: [] as string[], metadataChanged: [] as string[], typeChanged: [] as string[] };
  if (before.mode !== after.mode) ref.metadataChanged.push(".");
  for (const path of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(path);
    const y = a.get(path);
    if (x === undefined) ref.added.push(path);
    else if (y === undefined) ref.removed.push(path);
    else if (x.kind !== y.kind) ref.typeChanged.push(path);
    else if (x.kind === "file" && y.kind === "file") {
      if (x.content !== y.content) ref.modified.push(path);
      else if (x.mode !== y.mode) ref.metadataChanged.push(path);
    } else if (x.kind === "link" && y.kind === "link") {
      if (x.target !== y.target) ref.modified.push(path);
    } else if (x.kind === "dir" && y.kind === "dir" && x.mode !== y.mode) {
      ref.metadataChanged.push(path);
    }
  }
  for (const list of Object.values(ref)) list.sort(byCodeUnit);
  return ref;
}

const paths = (r: DiffResult) => ({
  added: r.added.map((e) => e.path),
  removed: r.removed.map((e) => e.path),
  modified: r.modified.map((e) => e.path),
  metadataChanged: r.metadataChanged.map((e) => e.path),
  typeChanged: r.typeChanged.map((e) => e.path),
});

/** The paths of a node and everything below it, relative to that node ("" for the node itself), with their content. */
function subtree(tree: DirT, at: string): Map<string, unknown> {
  const all = flatten(tree);
  const out = new Map<string, unknown>();
  for (const [path, node] of all) {
    if (path !== at && !path.startsWith(`${at}/`)) continue;
    const rel = path.slice(at.length);
    out.set(rel, moveIdentity(node, rel === ""));
  }
  return out;
}

/**
 * What must be equal for a node to count as moved: its kind and content, and
 * its mode unless it is the moved node itself (whose mode change the move
 * entry reports). Children are compared through their own paths.
 */
function moveIdentity(node: Tree, isMovedNode: boolean): unknown {
  switch (node.kind) {
    case "file":
      return isMovedNode ? { kind: node.kind, content: node.content } : { kind: node.kind, content: node.content, mode: node.mode };
    case "link":
      return { kind: node.kind, target: node.target };
    case "dir":
      return isMovedNode ? { kind: node.kind } : { kind: node.kind, mode: node.mode };
  }
}

const params = (): fc.Parameters<unknown> => ({
  seed: process.env.FC_SEED === undefined ? 20261101 : Number(process.env.FC_SEED),
  numRuns: process.env.FC_RUNS === undefined ? 300 : Number(process.env.FC_RUNS),
  ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH, endOnFailure: true }),
});

/** A tree and a mutated copy of it, plus an unrelated second tree. */
const scenario = fc.record({
  before: dirArb,
  mutations: fc.array(mutationArb, { maxLength: 8 }),
  other: dirArb,
  useOther: fc.boolean(),
});

function sides({ before, mutations, other, useOther }: { before: DirT; mutations: Mutation[]; other: DirT; useOther: boolean }) {
  const after = useOther ? structuredClone(other) : structuredClone(before);
  if (!useOther) for (const m of mutations) mutate(after, m);
  return { before, after };
}

describe("diff against a naive reference", () => {
  it("matches the reference exactly when moves are off, with and without pruning", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { before, after } = sides(s);
        const b = fromObject(toSpec(before), { rootMode: before.mode });
        const a = fromObject(toSpec(after), { rootMode: after.mode });
        const ref = referenceDiff(before, after);
        expect(paths(diff(b, a, { detectMoves: false }))).toEqual(ref);
        // compareMtime turns pruning off; every mtime is 0 here, so the result must not change.
        expect(paths(diff(b, a, { detectMoves: false, compareMtime: true }))).toEqual(ref);
      }),
      params(),
    );
  });

  it("reduces to the reference when each move is expanded back into its removed and added paths", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { before, after } = sides(s);
        const r = diff(fromObject(toSpec(before), { rootMode: before.mode }), fromObject(toSpec(after), { rootMode: after.mode }));
        const ref = referenceDiff(before, after);
        const removed = new Set(r.removed.map((e) => e.path));
        const added = new Set(r.added.map((e) => e.path));
        const sources = new Set<string>();
        const targets = new Set<string>();
        for (const m of r.moved) {
          // 1-to-1: no path is the source or target of two moves.
          expect(sources.has(m.from) || targets.has(m.to)).toBe(false);
          sources.add(m.from);
          targets.add(m.to);
          // The moved content really is identical (apart from the moved node's own mode).
          expect(subtree(after, m.to)).toEqual(subtree(before, m.from));
          for (const rel of subtree(before, m.from).keys()) removed.add(m.from + rel);
          for (const rel of subtree(after, m.to).keys()) added.add(m.to + rel);
        }
        expect({ ...paths(r), added: [...added].sort(byCodeUnit), removed: [...removed].sort(byCodeUnit) }).toEqual(ref);
      }),
      params(),
    );
  });

  it("never moves content that appears more than once on either side; those paths stay removed/added", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { before, after } = sides(s);
        const r = diff(fromObject(toSpec(before), { rootMode: before.mode }), fromObject(toSpec(after), { rootMode: after.mode }));
        const ref = referenceDiff(before, after);
        const sources = r.moved.map((m) => m.from);
        const targets = r.moved.map((m) => m.to);
        const reportedRemoved = r.removed.map((e) => e.path);
        const reportedAdded = r.added.map((e) => e.path);

        // The paths that are still unmatched when a candidate's turn comes: one-sided,
        // with identifying content, and not inside a (larger) moved folder.
        const candidates = (tree: DirT, onlyHere: string[], movedEnds: string[]) => {
          const nodes = flatten(tree);
          return onlyHere.filter((p) => {
            const node = nodes.get(p);
            return node !== undefined && isMoveCandidate(node) && !movedEnds.some((end) => p.startsWith(`${end}/`));
          });
        };
        const contentKey = (tree: DirT, p: string) => JSON.stringify([...subtree(tree, p)].sort(([x], [y]) => byCodeUnit(x, y)));
        const counts = (tree: DirT, paths: string[]) => {
          const byKey = new Map<string, number>();
          for (const p of paths) byKey.set(contentKey(tree, p), (byKey.get(contentKey(tree, p)) ?? 0) + 1);
          return byKey;
        };
        const removed = candidates(before, ref.removed, sources);
        const added = candidates(after, ref.added, targets);
        const removedCounts = counts(before, removed);
        const addedCounts = counts(after, added);
        const isDuplicated = (key: string) => (removedCounts.get(key) ?? 0) > 1 || (addedCounts.get(key) ?? 0) > 1;

        for (const p of removed) {
          if (!isDuplicated(contentKey(before, p))) continue;
          expect(sources).not.toContain(p);
          expect(reportedRemoved).toContain(p);
        }
        for (const p of added) {
          if (!isDuplicated(contentKey(after, p))) continue;
          expect(targets).not.toContain(p);
          expect(reportedAdded).toContain(p);
        }
      }),
      params(),
    );
  });

  it("reports nothing for a tree compared with itself, and prunes at the root", () => {
    fc.assert(
      fc.property(dirArb, (tree) => {
        const snap = fromObject(toSpec(tree), { rootMode: tree.mode });
        const r = diff(snap, fromObject(toSpec(structuredClone(tree)), { rootMode: tree.mode }));
        expect(r.summary.total).toBe(0);
        expect(r.stats).toEqual({ visitedNodes: 1, prunedSubtrees: 1, skippedUnreadable: 0 });
      }),
      params(),
    );
  });
});
