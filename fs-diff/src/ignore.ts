/**
 * Minimal ignore patterns, a small subset of .gitignore:
 *
 * - A pattern without `/` matches an entry's name at any depth: `node_modules`, `*.log`.
 * - A pattern with a `/` at the start or in the middle matches the whole path
 *   relative to the root: `/dist`, `build/cache`, `build/*.tmp`.
 * - A trailing `/` restricts the pattern to directories: `build/` ignores a
 *   `build` folder at any depth but not a file named `build`.
 * - `*` matches any run of characters except `/`, `?` one character except `/`,
 *   and `**` any run of characters including `/`.
 * - `/` is the only separator. `\` is an ordinary character (it is legal in
 *   POSIX file names), as in .gitignore, which also requires `/` on Windows.
 *
 * An ignored directory is not descended into at all. Negation (`!pattern`) is
 * not supported, so the order of patterns never matters.
 */

interface Rule {
  regex: RegExp;
  /** Match against the relative path (true) or just the entry name (false). */
  anchored: boolean;
  directoryOnly: boolean;
}

/** Returns a predicate telling whether an entry is ignored. */
export function createIgnoreMatcher(
  patterns: readonly string[],
): (relPath: string, name: string, isDirectory: boolean) => boolean {
  const rules: Rule[] = [];
  for (const raw of patterns) {
    let pattern = raw.trim();
    const directoryOnly = pattern.endsWith("/");
    pattern = pattern.replace(/\/+$/, "");
    const anchored = pattern.includes("/");
    pattern = pattern.replace(/^\/+/, "");
    if (pattern === "") continue;
    rules.push({ regex: globToRegExp(pattern), anchored, directoryOnly });
  }
  return (relPath, name, isDirectory) =>
    rules.some((rule) => (isDirectory || !rule.directoryOnly) && rule.regex.test(rule.anchored ? relPath : name));
}

/** Converts a glob to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` also matches zero directories, so `a/**/b` matches `a/b`.
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}
