import { describe, expect, it } from "vitest";
import { escapeInvalidName } from "../../src/model.js";
import { escapeJsonForTerminal, formatMessage, formatPath } from "../../src/quote.js";

describe("formatPath", () => {
  it.each([["a.txt"], ["dir/sub/file name.md"], ["日本語/über 🌍.txt"], ["café"], ["it's"], ["."]])("prints safe text %j as is", (text) => {
    expect(formatPath(text)).toBe(text);
  });

  it.each([
    ["", '""'],
    ["a\nb", '"a\\nb"'],
    ["a\rb", '"a\\rb"'],
    ["a\tb", '"a\\tb"'],
    ['say "hi"', '"say \\"hi\\""'],
    ["a\\b", '"a\\\\b"'],
    ["\0\x01\x1f", '"\\x00\\x01\\x1F"'],
    ["esc\x1b[2K", '"esc\\x1B[2K"'],
    ["del\x7f", '"del\\x7F"'],
    // C1 controls print as their two UTF-8 bytes, so every \xNN is one byte.
    ["nel\u0085", '"nel\\xC2\\x85"'],
    ["csi\u009b", '"csi\\xC2\\x9B"'],
    ["bidi\u202Etxt.exe", '"bidi\\u{202E}txt.exe"'],
    ["isolate\u2066x\u2069", '"isolate\\u{2066}x\\u{2069}"'],
    ["zero\u200Bwidth\u200C\u200D\uFEFF", '"zero\\u{200B}width\\u{200C}\\u{200D}\\u{FEFF}"'],
    ["line\u2028para\u2029", '"line\\u{2028}para\\u{2029}"'],
    ["lone\uD800", '"lone\\u{D800}"'],
  ])("quotes and escapes %j as %s", (text, expected) => {
    expect(formatPath(text)).toBe(expected);
  });

  it("prints escaped invalid-UTF-8 bytes as \\xNN and a real backslash as \\\\, so the two never look alike", () => {
    const escaped = escapeInvalidName(Uint8Array.of(0x61, 0xff)); // "a\xFF" in the stored format
    expect(formatPath(escaped, 0)).toBe('"a\\xFF"');
    expect(formatPath("a\\xFF")).toBe('"a\\\\xFF"'); // a name that really reads a\xFF
    // A real backslash and a newline inside an invalid name.
    expect(formatPath(escapeInvalidName(Uint8Array.of(0x0a, 0x5c, 0xff)), 0)).toBe('"\\n\\\\\\xFF"');
  });

  it("applies the escape format only from escapedFrom on", () => {
    const parent = "d\\x41"; // a valid folder name that really contains a backslash
    const path = `${parent}/${escapeInvalidName(Uint8Array.of(0x41, 0xfe))}`;
    expect(formatPath(path, parent.length + 1)).toBe('"d\\\\x41/A\\xFE"');
  });

  it.each([
    ["a -> b", '"a -> b"'],
    ["a->b", '"a->b"'],
    ["a  b", '"a  b"'],
    [" a", '" a"'],
    ["a ", '"a "'],
    [" ", '" "'],
  ])("quotes %j, which could otherwise blur the report's separators", (text, expected) => {
    expect(formatPath(text)).toBe(expected);
  });

  it("leaves single inner spaces and a lone > or - alone", () => {
    expect(formatPath("my file - copy > 2.txt")).toBe("my file - copy > 2.txt");
  });

  it("never returns an unquoted string that starts with a quote", () => {
    expect(formatPath('"a"')).toBe('"\\"a\\""');
  });
});

describe("formatMessage", () => {
  it("leaves ordinary text, quotes and backslashes alone", () => {
    expect(formatMessage('unknown field "x" in C:\\dir')).toBe('unknown field "x" in C:\\dir');
  });

  it("escapes line breaks, control characters and unsafe Unicode", () => {
    expect(formatMessage("open '/t/a\n\x1b[2K\u202Eb'")).toBe("open '/t/a\\n\\x1B[2K\\u{202E}b'");
  });
});

describe("escapeJsonForTerminal", () => {
  const unsafe = ["\u007F", "\u0080", "\u009B", "\u009F", "\u202A", "\u202E", "\u2066", "\u2069", "\u200B", "\u200D", "\uFEFF", "\u2028", "\u2029", "\u{E0001}"];
  const value = { name: `a${unsafe.join("b")}c`, list: unsafe, plain: "safe \u00E9 \u{1F30D}", n: 1 };

  it("leaves no raw unsafe character and parses back to exactly the same data", () => {
    const json = escapeJsonForTerminal(JSON.stringify(value));
    expect(json).not.toMatch(/[\u007F-\u009F\p{Cf}\u2028\u2029]/u);
    expect(JSON.parse(json)).toEqual(value);
  });

  it("writes \\uXXXX escapes, with a surrogate pair above U+FFFF, and leaves safe text alone", () => {
    expect(escapeJsonForTerminal(JSON.stringify("\u009B\u202E\u{E0001}"))).toBe('"\\u009B\\u202E\\uDB40\\uDC01"');
    expect(escapeJsonForTerminal(JSON.stringify(value.plain))).toBe(JSON.stringify(value.plain));
  });
});
