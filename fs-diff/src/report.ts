/** Human-readable rendering of a {@link DiffResult}. */
import type { DiffResult, MetadataChange } from "./diff.js";
import { compareNames, type NodeType, type SymlinkNode } from "./model.js";
import { formatPath } from "./quote.js";

/**
 * One line per change, sorted by path:
 *
 *   + added        - removed        ~ modified / metadata / type change
 *   > from -> to   moved (followed by any metadata change, e.g. `mode 0644 -> 0755`)
 *
 * Paths and link targets are quoted when needed (see formatPath), so a name
 * can never add, hide or rewrite a line. Directories get a trailing `/`
 * (outside any quotes); the root itself is `./`. A type change shows
 * the path as it is in `after`, so `~ x/  type file -> directory` is now a
 * folder and `~ x  type directory -> file` is now a file. Ends with a summary line.
 */
export function formatReport(result: DiffResult): string {
  const lines: Array<{ path: string; text: string }> = [];
  const add = (path: string, text: string) => lines.push({ path, text });

  for (const e of result.added) add(e.path, `+ ${display(e.path, e.type)}`);
  for (const e of result.removed) add(e.path, `- ${display(e.path, e.type)}`);
  for (const e of result.modified) {
    const detail =
      e.type === "file"
        ? `content changed (${formatSize(e.before.size)} -> ${formatSize(e.after.size)})`
        : `link target ${formatTarget(e.before)} -> ${formatTarget(e.after)}`;
    add(e.path, `~ ${display(e.path, e.type)}  ${detail}`);
  }
  for (const e of result.metadataChanged) {
    add(e.path, `~ ${display(e.path, e.type)}  ${e.changes.map(formatMetadataChange).join(", ")}`);
  }
  for (const e of result.typeChanged) add(e.path, `~ ${display(e.path, e.after)}  type ${e.before} -> ${e.after}`);
  for (const e of result.moved) {
    const detail = e.changes.length > 0 ? `  ${e.changes.map(formatMetadataChange).join(", ")}` : "";
    add(e.from, `> ${display(e.from, e.type)} -> ${display(e.to, e.type)}${detail}`);
  }

  lines.sort((x, y) => compareNames(x.path, y.path));

  const s = result.summary;
  const summary =
    s.total === 0
      ? "No differences."
      : `${s.total} change(s): ${s.added} added, ${s.removed} removed, ${s.modified} modified, ` +
        `${s.metadataChanged} metadata changed, ${s.typeChanged} type changed, ${s.moved} moved.`;
  const stats = `Visited ${result.stats.visitedNodes} node(s), skipped ${result.stats.prunedSubtrees} identical subtree(s).`;

  return [...lines.map((l) => l.text), ...(lines.length > 0 ? [""] : []), summary, stats].join("\n");
}

function display(path: string, type: NodeType): string {
  return type === "directory" ? `${formatPath(path)}/` : formatPath(path);
}

/**
 * An escaped target prints its bytes as `\xNN` inside quotes, and is labelled
 * outside the quotes, where no target text can reach.
 */
function formatTarget(link: SymlinkNode): string {
  return link.targetEscaped ? `${formatPath(link.target, 0)} (escaped: not valid UTF-8)` : formatPath(link.target);
}

function formatMetadataChange(change: MetadataChange): string {
  if (change.field === "mode") return `mode ${formatMode(change.before)} -> ${formatMode(change.after)}`;
  return `mtime ${new Date(change.before).toISOString()} -> ${new Date(change.after).toISOString()}`;
}

/** Permission bits as four octal digits, e.g. 0755. */
export function formatMode(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
