/**
 * Safe display of untrusted text (file names, symlink targets, arguments,
 * error messages) in human-readable output.
 *
 * Anyone who can create a file in the scanned tree chooses its name, and a
 * name may contain any character except `/` and NUL: newlines, carriage
 * returns, terminal escape sequences, bidi overrides. Printed raw, such a name
 * can forge or erase report lines or send control codes to the terminal. So
 * every such string is printed through {@link formatPath} (quoted, like Git's
 * `core.quotePath`) or, for free-text messages, {@link formatMessage}.
 */

/**
 * Characters that are never printed raw: Unicode format characters (bidi
 * controls such as U+202E, zero-width characters, U+FEFF), line and paragraph
 * separators (U+2028/U+2029) and lone surrogates. Control characters (Cc) are
 * handled separately, with `\n`-style or `\xNN` escapes.
 */
const UNSAFE = /^[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]$/u;

/** The escape for one character that must not be printed raw, or undefined if it is safe. */
function escapeUnsafe(char: string): string | undefined {
  const code = char.codePointAt(0)!; // non-null: see README "Non-null assertions"
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  if (char === "\t") return "\\t";
  if (code < 0x20 || code === 0x7f) return byteEscape(code);
  // C1 controls are two bytes in UTF-8. Escaping both keeps every `\xNN` one
  // byte, so U+0085 (`\xC2\x85`) can't be confused with a lone invalid byte 0x85 (`\x85`).
  if (code >= 0x80 && code <= 0x9f) return byteEscape(0xc2) + byteEscape(code);
  if (UNSAFE.test(char)) return `\\u{${code.toString(16).toUpperCase()}}`;
  return undefined;
}

function byteEscape(byte: number): string {
  return `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Quotes a path or symlink target for display, like Git with `core.quotePath`:
 *
 * - printed as is if it is non-empty and every character is safe;
 * - otherwise printed inside double quotes, with `\n`, `\r`, `\t`, `\"`, `\\`,
 *   other control characters (U+0000-U+001F, U+007F, U+0080-U+009F) as
 *   `\xNN` (C1 controls as their two UTF-8 bytes), and other unsafe Unicode
 *   (bidi controls, zero-width characters, U+2028/U+2029) as `\u{...}`.
 *
 * A string with `"` or `\` is always quoted, so an unquoted result never
 * starts with `"` and quoted and unquoted output can't be confused. So is one
 * containing `->`, two spaces in a row, or a leading or trailing space: the
 * report uses ` -> ` and two spaces as separators, so without this two
 * different changes could print the same line (`> a -> b -> c`), and an edge
 * space would be invisible.
 *
 * `escapedFrom` marks where `text` switches to the escapeInvalidName format
 * (an invalid-UTF-8 name is the last segment of a path; an escaped symlink
 * target is the whole text). That part's `\xHH` escapes stand for raw bytes
 * and are printed as such, inside quotes, while its `\\` is a real backslash.
 * So the escaped bytes `a\xFF` print as `"a\xFF"`, and a name that really
 * reads `a\xFF` prints as `"a\\xFF"`.
 */
export function formatPath(text: string, escapedFrom = text.length): string {
  let out = "";
  let quote = text === "" || text.includes("->") || text.includes("  ") || text.startsWith(" ") || text.endsWith(" ");
  const add = (char: string) => {
    const escaped = char === '"' ? '\\"' : char === "\\" ? "\\\\" : escapeUnsafe(char);
    if (escaped === undefined) {
      out += char;
    } else {
      out += escaped;
      quote = true;
    }
  };

  for (const char of text.slice(0, escapedFrom)) add(char);
  // The escape format's tokens: a raw byte (`\xHH`, already in the output form), a real backslash, or one character.
  for (const [token] of text.slice(escapedFrom).matchAll(/\\x[0-9A-F]{2}|\\\\|[^]/gu)) {
    if (token === "\\\\") {
      add("\\");
    } else if (token.length === 4) {
      out += token;
      quote = true;
    } else {
      add(token);
    }
  }
  return quote ? `"${out}"` : out;
}

/**
 * Makes free text (an error message or warning that may contain names or
 * paths) safe to print: control and unsafe Unicode characters get the same
 * escapes as in {@link formatPath}, but nothing is quoted and `"` and `\` are
 * left alone, so ordinary messages read normally. The result never contains a
 * line break or a control character.
 */
export function formatMessage(text: string): string {
  let out = "";
  for (const char of text) out += escapeUnsafe(char) ?? char;
  return out;
}

/**
 * Characters that JSON.stringify writes raw but a terminal or bidi-aware viewer
 * may act on: DEL, C1 controls, format characters (bidi overrides and
 * isolates, zero-width characters, U+FEFF, ...) and U+2028/U+2029.
 * JSON.stringify already escapes C0 controls and lone surrogates.
 */
const JSON_UNSAFE = /[\u007F-\u009F\p{Cf}\u2028\u2029]/gu;

/**
 * Makes JSON text safe to print to a terminal by writing those characters as
 * `\uXXXX` escapes (a surrogate pair for one above U+FFFF). They can only
 * occur inside JSON strings, where the escape means the same character, so
 * `JSON.parse` returns exactly the same data.
 */
export function escapeJsonForTerminal(json: string): string {
  return json.replace(JSON_UNSAFE, (char) =>
    Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`).join(""),
  );
}
