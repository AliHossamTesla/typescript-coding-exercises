/**
 * Difference between two snapshots of the same tree taken at different times.
 *
 * Algorithm:
 * 1. Walk both trees together. Children are sorted by name, so each directory
 *    is compared with a linear merge. Directories with equal Merkle hashes are
 *    skipped without visiting their children.
 * 2. Paths found on only one side are collected as candidate adds/removes.
 * 3. Candidates whose content hash matches exactly one candidate on the other
 *    side are paired up as moves, largest subtrees first.
 */
import {
  compareNames,
  joinPath,
  nodeHash,
  type DirectoryNode,
  type FileNode,
  type FsNode,
  type NodeType,
  type Snapshot,
  type SnapshotError,
  type SymlinkNode,
} from "./model.js";

export interface DiffOptions {
  /**
   * Report files whose only change is mtime under `metadataChanged`. Off by
   * default: mtime changes on a mere touch or copy and is usually noise.
   * Turning it on disables Merkle pruning, since mtime is not part of the hash.
   */
  compareMtime?: boolean;
  /** Pair up identical removed/added content as moves. On by default. */
  detectMoves?: boolean;
}

/** A path that exists on only one side. */
export interface PathEntry {
  path: string;
  type: NodeType;
}

/** A file whose content changed, or a symlink whose target changed. Both sides always have the same type. */
export type ModifiedEntry =
  | { path: string; type: "file"; before: FileNode; after: FileNode }
  | { path: string; type: "symlink"; before: SymlinkNode; after: SymlinkNode };

export interface MetadataChange {
  field: "mode" | "mtimeMs";
  before: number;
  after: number;
}

/** Same content, different metadata. */
export interface MetadataChangedEntry {
  path: string;
  type: "file" | "directory";
  changes: MetadataChange[];
}

/** The same path holds a different kind of node, e.g. a file became a directory. */
export interface TypeChangedEntry {
  path: string;
  before: NodeType;
  after: NodeType;
}

/**
 * A file, symlink or whole directory that disappeared from `from` and
 * reappeared with the same content at `to`. Metadata that changed along the
 * way (mode, or mtime with `compareMtime`) is listed in `changes`.
 */
export interface MovedEntry {
  from: string;
  to: string;
  type: NodeType;
  /** Metadata of the moved node itself that differs; empty for a plain move. */
  changes: MetadataChange[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  modified: number;
  metadataChanged: number;
  typeChanged: number;
  moved: number;
  total: number;
}

export interface DiffStats {
  /** Node pairs compared plus nodes walked in added/removed subtrees. */
  visitedNodes: number;
  /** Directory pairs skipped because their Merkle hashes were equal. */
  prunedSubtrees: number;
  /** One-sided paths not reported because their state was unknown (unreadable or invalid name) in one of the snapshots. */
  skippedUnreadable: number;
}

export interface DiffResult {
  added: PathEntry[];
  removed: PathEntry[];
  modified: ModifiedEntry[];
  metadataChanged: MetadataChangedEntry[];
  typeChanged: TypeChangedEntry[];
  moved: MovedEntry[];
  summary: DiffSummary;
  stats: DiffStats;
  /** Things that make the result less trustworthy, e.g. different ignore lists or scan errors. */
  warnings: string[];
}

/** The path used for the root directory itself in results, e.g. for a root `chmod`. */
export const ROOT_PATH = ".";

/** Computes what changed between `before` and `after`. All paths are relative to the snapshot roots. */
export function diff(before: Snapshot, after: Snapshot, options: DiffOptions = {}): DiffResult {
  if (before.options.fast !== after.options.fast) {
    throw new Error("cannot diff a fast-mode snapshot against a full-hash snapshot: their file hashes are not comparable");
  }
  const compareMtime = options.compareMtime ?? false;
  const canPrune = !compareMtime;

  // Paths whose state is unknown in either snapshot (unreadable, or a name that
  // is not valid UTF-8). If such a path (or anything under it) is present on
  // only one side, we do not know whether it really changed, so we don't report
  // it. Only `unsupported` errors (sockets, FIFOs, devices) are left out: those
  // paths are untracked, so they count as absent and do not hide a change.
  const unreadable = new Set([...before.errors, ...after.errors].filter(isUnknownState).map((e) => e.path));

  // Path -> node for everything present on only one side, in pre-order (parents first).
  const removed = new Map<string, FsNode>();
  const added = new Map<string, FsNode>();
  const modified: ModifiedEntry[] = [];
  const metadataChanged: MetadataChangedEntry[] = [];
  const typeChanged: TypeChangedEntry[] = [];
  const stats: DiffStats = { visitedNodes: 0, prunedSubtrees: 0, skippedUnreadable: 0 };

  /**
   * Records `node` and all of its descendants as present on one side only.
   * Unreadable paths are skipped at every depth, together with their subtrees.
   */
  function collect(into: Map<string, FsNode>, node: FsNode, path: string): void {
    if (unreadable.has(path)) {
      stats.skippedUnreadable++;
      return;
    }
    stats.visitedNodes++;
    into.set(path, node);
    if (node.type === "directory") {
      for (const child of node.children) collect(into, child, joinPath(path, child.name));
    }
  }

  /** Linear merge of two sorted child lists. */
  function compareDirectories(b: DirectoryNode, a: DirectoryNode, path: string): void {
    if (canPrune && b.hash === a.hash) {
      stats.prunedSubtrees++;
      return;
    }
    let i = 0;
    let j = 0;
    for (;;) {
      const bc = b.children[i];
      const ac = a.children[j];
      // One list is used up: the rest of the other exists on that side only.
      if (bc === undefined) {
        for (const rest of a.children.slice(j)) collect(added, rest, joinPath(path, rest.name));
        return;
      }
      if (ac === undefined) {
        for (const rest of b.children.slice(i)) collect(removed, rest, joinPath(path, rest.name));
        return;
      }
      const order = compareNames(bc.name, ac.name);
      if (order < 0) {
        collect(removed, bc, joinPath(path, bc.name));
        i++;
      } else if (order > 0) {
        collect(added, ac, joinPath(path, ac.name));
        j++;
      } else {
        compareNodes(bc, ac, joinPath(path, bc.name));
        i++;
        j++;
      }
    }
  }

  /** Compares two nodes that live at the same path. */
  function compareNodes(b: FsNode, a: FsNode, path: string): void {
    stats.visitedNodes++;
    if (b.type === "file" && a.type === "file") {
      if (b.contentHash !== a.contentHash) {
        modified.push({ path, type: "file", before: b, after: a });
      } else {
        const changes = metadataChanges(b, a, compareMtime);
        if (changes.length > 0) metadataChanged.push({ path, type: "file", changes });
      }
    } else if (b.type === "symlink" && a.type === "symlink") {
      // nodeHash, not target: an escaped target must differ from the same text unescaped.
      if (nodeHash(b) !== nodeHash(a)) modified.push({ path, type: "symlink", before: b, after: a });
    } else if (b.type === "directory" && a.type === "directory") {
      if (b.mode !== a.mode) {
        metadataChanged.push({ path, type: "directory", changes: [{ field: "mode", before: b.mode, after: a.mode }] });
      }
      compareDirectories(b, a, path);
    } else {
      // The types differ: every same-type pair was handled above.
      typeChanged.push({ path, before: b.type, after: a.type });
      // Whatever was inside a directory on one side exists only on that side.
      if (b.type === "directory") for (const c of b.children) collect(removed, c, joinPath(path, c.name));
      if (a.type === "directory") for (const c of a.children) collect(added, c, joinPath(path, c.name));
    }
  }

  stats.visitedNodes++; // the root pair
  // The root's own mode is in no hash (it has no parent entry), so compare it explicitly.
  if (before.root.mode !== after.root.mode) {
    metadataChanged.push({
      path: ROOT_PATH,
      type: "directory",
      changes: [{ field: "mode", before: before.root.mode, after: after.root.mode }],
    });
  }
  compareDirectories(before.root, after.root, "");

  const moved = options.detectMoves === false ? [] : detectMoves(removed, added, compareMtime);

  const result = {
    added: toEntries(added),
    removed: toEntries(removed),
    modified: modified.sort(byPath),
    metadataChanged: metadataChanged.sort(byPath),
    typeChanged: typeChanged.sort(byPath),
    moved: moved.sort((x, y) => compareNames(x.from, y.from)),
  };
  return {
    ...result,
    summary: {
      added: result.added.length,
      removed: result.removed.length,
      modified: result.modified.length,
      metadataChanged: result.metadataChanged.length,
      typeChanged: result.typeChanged.length,
      moved: result.moved.length,
      total: Object.values(result).reduce((sum, list) => sum + list.length, 0),
    },
    stats,
    warnings: compatibilityWarnings(before, after),
  };
}

/**
 * Pairs removed and added paths with identical content, consuming them from both maps.
 *
 * Candidates are tried largest subtree first, so a renamed folder becomes one
 * move and its contents are taken out before smaller pieces are considered.
 * A pair is only made when its hash occurs exactly once among the removed
 * candidates and exactly once among the added ones that are still unmatched;
 * anything ambiguous stays an add + remove. Empty files and empty directories
 * are never matched: they all share one hash, so any pairing would be a guess.
 *
 * Why largest first: a candidate's bucket can only shrink when a larger
 * ancestor moves and consumes it. Trying larger subtrees first means every
 * such consumption has already happened when a candidate is considered, so
 * the result does not depend on path names or iteration order.
 */
function detectMoves(removed: Map<string, FsNode>, added: Map<string, FsNode>, compareMtime: boolean): MovedEntry[] {
  const removedByKey = indexByKey(removed);
  const addedByKey = indexByKey(added);
  const sizes = new Map<FsNode, number>();
  const candidates = [...removed]
    .filter(([, node]) => isMoveCandidate(node))
    .map(([path, node]) => ({ path, node, size: subtreeSize(node, sizes) }))
    .sort((x, y) => y.size - x.size || compareNames(x.path, y.path));

  const moves: MovedEntry[] = [];
  for (const { path: from, node } of candidates) {
    if (!removed.has(from)) continue; // consumed by a larger move
    const key = moveKey(node);
    // The only remaining removed candidate with this content must be `from` itself.
    if (onlyEntry(removedByKey.get(key)) === undefined) continue;
    const match = onlyEntry(addedByKey.get(key));
    if (match === undefined) continue;
    const [to, target] = match;
    moves.push({ from, to, type: node.type, changes: moveMetadataChanges(node, target, compareMtime) });
    consume(removed, removedByKey, node, from);
    consume(added, addedByKey, target, to);
  }
  return moves;
}

/** Only nodes with identifying content can be matched: non-empty files and directories, and symlinks. */
function isMoveCandidate(node: FsNode): boolean {
  switch (node.type) {
    case "file":
      return node.size > 0;
    case "directory":
      return node.children.length > 0;
    case "symlink":
      return true;
  }
}

/** Content identity used for move matching; includes the type so a file never matches a symlink. */
function moveKey(node: FsNode): string {
  return `${node.type}:${nodeHash(node)}`;
}

/** Path -> node maps of the candidates in a path map, grouped by move key, so consumed paths can be removed in O(1). */
type MoveIndex = Map<string, Map<string, FsNode>>;

function indexByKey(nodes: Map<string, FsNode>): MoveIndex {
  const index: MoveIndex = new Map();
  for (const [path, node] of nodes) {
    if (!isMoveCandidate(node)) continue;
    const key = moveKey(node);
    const group = index.get(key);
    if (group) group.set(path, node);
    else index.set(key, new Map([[path, node]]));
  }
  return index;
}

/** The single [path, node] of a group, or undefined if the group is missing, empty or has more than one. */
function onlyEntry(group: Map<string, FsNode> | undefined): [string, FsNode] | undefined {
  return group?.size === 1 ? group.entries().next().value : undefined;
}

/** Number of nodes in a subtree, memoized so sizing every candidate stays linear overall. */
function subtreeSize(node: FsNode, memo: Map<FsNode, number>): number {
  if (node.type !== "directory") return 1;
  let size = memo.get(node);
  if (size === undefined) {
    size = 1;
    for (const child of node.children) size += subtreeSize(child, memo);
    memo.set(node, size);
  }
  return size;
}

/** Removes a node and its whole subtree from a path map and from its move index. */
function consume(nodes: Map<string, FsNode>, index: MoveIndex, node: FsNode, path: string): void {
  if (!nodes.delete(path)) return; // not collected (unreadable), so not indexed either
  if (isMoveCandidate(node)) index.get(moveKey(node))?.delete(path);
  if (node.type === "directory") {
    for (const child of node.children) consume(nodes, index, child, joinPath(path, child.name));
  }
}

/**
 * Metadata of the moved node itself. A directory's descendants need no check:
 * their modes are part of the directory hash, which matched.
 */
function moveMetadataChanges(b: FsNode, a: FsNode, compareMtime: boolean): MetadataChange[] {
  if (b.type === "file" && a.type === "file") return metadataChanges(b, a, compareMtime);
  if (b.type === "directory" && a.type === "directory" && b.mode !== a.mode) {
    return [{ field: "mode", before: b.mode, after: a.mode }];
  }
  return [];
}

function metadataChanges(b: FileNode, a: FileNode, compareMtime: boolean): MetadataChange[] {
  const changes: MetadataChange[] = [];
  if (b.mode !== a.mode) changes.push({ field: "mode", before: b.mode, after: a.mode });
  if (compareMtime && b.mtimeMs !== a.mtimeMs) changes.push({ field: "mtimeMs", before: b.mtimeMs, after: a.mtimeMs });
  return changes;
}

function compatibilityWarnings(before: Snapshot, after: Snapshot): string[] {
  const warnings: string[] = [];
  // Patterns have no negation, so their order is irrelevant: compare as sets.
  const normalize = (patterns: string[]) => JSON.stringify([...new Set(patterns)].sort(compareNames));
  if (normalize(before.options.ignore) !== normalize(after.options.ignore)) {
    warnings.push(
      `snapshots used different ignore lists (${JSON.stringify(before.options.ignore)} vs ${JSON.stringify(after.options.ignore)}); ignored paths may show up as added or removed`,
    );
  }
  for (const [label, snap] of [["before", before], ["after", after]] as const) {
    const unknown = snap.errors.filter(isUnknownState).length;
    const unsupported = snap.errors.length - unknown;
    if (unknown > 0) {
      warnings.push(
        `${unknown} path(s) could not be read in the ${label} snapshot (read errors or file names that are not valid UTF-8); changes at or under them are not reported`,
      );
    }
    if (unsupported > 0) {
      warnings.push(`${unsupported} path(s) in the ${label} snapshot are sockets, FIFOs or devices, which are not tracked and are treated as absent`);
    }
  }
  return warnings;
}

/** The path exists but its contents are unknown: everything except an unsupported file type. */
function isUnknownState(error: SnapshotError): boolean {
  return error.kind !== "unsupported";
}

function toEntries(nodes: Map<string, FsNode>): PathEntry[] {
  return [...nodes].map(([path, node]) => ({ path, type: node.type })).sort(byPath);
}

function byPath(x: { path: string }, y: { path: string }): number {
  return compareNames(x.path, y.path);
}
