import { describe, expect, it } from "vitest";
import { diff } from "../../src/diff.js";
import { formatMode, formatReport, formatSize } from "../../src/report.js";
import { directory, file, fromObject, symlink } from "../../src/snapshot.js";

describe("formatReport", () => {
  it("prints one marked line per change, sorted by path, then a summary", () => {
    const before = fromObject({
      "gone.txt": "bye",
      old: { "a.txt": "a" },
      "run.sh": file("#!", { mode: 0o644 }),
      x: "file",
      l: symlink("a"),
      "edit.md": "v1",
      d: directory({}, { mode: 0o755 }),
    });
    const after = fromObject({
      "new.txt": "hi",
      renamed: { "a.txt": "a" },
      "run.sh": file("#!", { mode: 0o755 }),
      x: { y: "dir now" },
      l: symlink("b"),
      "edit.md": "draft two",
      d: directory({}, { mode: 0o700 }),
    });
    expect(formatReport(diff(before, after))).toBe(
      [
        "~ d/  mode 0755 -> 0700",
        "~ edit.md  content changed (2 B -> 9 B)",
        "- gone.txt",
        "~ l  link target a -> b",
        "+ new.txt",
        "> old/ -> renamed/",
        "~ run.sh  mode 0644 -> 0755",
        "~ x/  type file -> directory",
        "+ x/y",
        "",
        "9 change(s): 2 added, 1 removed, 2 modified, 2 metadata changed, 1 type changed, 1 moved.",
        "Visited 13 node(s), skipped 1 identical subtree(s).",
      ].join("\n"),
    );
  });

  it("shows a type change with the path as it is after the change", () => {
    const lines = (before: Parameters<typeof fromObject>[0], after: Parameters<typeof fromObject>[0]) =>
      formatReport(diff(fromObject(before), fromObject(after))).split("\n");
    expect(lines({ x: { y: "1" } }, { x: "file" }).slice(0, 2)).toEqual(["~ x  type directory -> file", "- x/y"]);
    expect(lines({ x: symlink("t") }, { x: {} })[0]).toBe("~ x/  type symlink -> directory");
    expect(lines({ x: "f" }, { x: symlink("t") })[0]).toBe("~ x  type file -> symlink");
  });

  it("labels a symlink target that is not valid UTF-8", () => {
    const r = diff(fromObject({ l: symlink(Uint8Array.of(0x61, 0xff)) }), fromObject({ l: symlink("a\\xFF") }));
    expect(formatReport(r).split("\n")[0]).toBe('~ l  link target "a\\xFF" (escaped: not valid UTF-8) -> "a\\\\xFF"');
  });

  it("reports mtime changes as ISO timestamps when asked", () => {
    const r = diff(fromObject({ a: file("x", { mtimeMs: 0 }) }), fromObject({ a: file("x", { mtimeMs: 86_400_000 }) }), {
      compareMtime: true,
    });
    expect(formatReport(r).split("\n")[0]).toBe("~ a  mtime 1970-01-01T00:00:00.000Z -> 1970-01-02T00:00:00.000Z");
  });

  it("says so when there are no differences", () => {
    const snap = fromObject({ a: "1" });
    expect(formatReport(diff(snap, snap))).toMatch(/^No differences\./);
  });

  it("formats modes and sizes", () => {
    expect(formatMode(0o755)).toBe("0755");
    expect(formatMode(0o4755)).toBe("4755");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KiB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5.0 GiB");
  });
});

/** Any character that must never reach the terminal raw. The report's own line breaks are the only allowed control character. */
const RAW_UNSAFE = /[\x00-\x09\x0B-\x1F\x7F-\x9F\p{Cf}\p{Zl}\p{Zp}]/u;

describe("formatReport with hostile names", () => {
  // A realistic attack: secret.key is really deleted, and the
  // attacker creates files whose names try to hide that and forge other lines.
  const hostile = {
    crForge: "aaa.log\r- payroll.xlsx  (moved to trash)",
    tab: "b\tc",
    nlForge: "link\n+ notes.txt\n- readme.md",
    eraser: "secret.key~\x1b[2K\x1b[1A\x1b[2K\r",
    color: "zz\x1b[31mRED\x1b[0m",
    title: "zzz\x1b]0;pwned-title\x07",
    bidi: "invoice‮txt.exe",
    zeroWidth: "pass​wd",
  };
  const before = fromObject({ "payroll.xlsx": "p", "readme.md": "r", "secret.key": "s" });
  const after = fromObject({
    "payroll.xlsx": "p",
    "readme.md": "r",
    ...Object.fromEntries(Object.values(hostile).map((name, i) => [name, `new ${i}`])),
  });
  const report = formatReport(diff(before, after));

  it("quotes every hostile name, so the real removal stays visible and nothing is forged", () => {
    expect(report.split("\n")).toEqual([
      '+ "aaa.log\\r- payroll.xlsx  (moved to trash)"',
      '+ "b\\tc"',
      '+ "invoice\\u{202E}txt.exe"',
      '+ "link\\n+ notes.txt\\n- readme.md"',
      '+ "pass\\u{200B}wd"',
      "- secret.key",
      '+ "secret.key~\\x1B[2K\\x1B[1A\\x1B[2K\\r"',
      '+ "zz\\x1B[31mRED\\x1B[0m"',
      '+ "zzz\\x1B]0;pwned-title\\x07"',
      "",
      "9 change(s): 8 added, 1 removed, 0 modified, 0 metadata changed, 0 type changed, 0 moved.",
      "Visited 12 node(s), skipped 0 identical subtree(s).",
    ]);
  });

  it("contains no control or invisible characters except its own line breaks", () => {
    expect(report).not.toMatch(RAW_UNSAFE);
  });

  it("quotes names on every kind of line, with the directory slash outside the quotes", () => {
    const evil = "e\nvil";
    const r = formatReport(
      diff(
        fromObject({ [evil]: { x: "1" }, f: file("1", { mode: 0o644 }), [`${evil}.f`]: "old", t: "file", l: symlink("a\x1b[2K") }),
        fromObject({ [`${evil}2`]: { x: "1" }, f: file("1", { mode: 0o755 }), [`${evil}.f`]: "new", t: { [evil]: "1" }, l: symlink("b") }),
      ),
    );
    expect(r.split("\n").slice(0, 6)).toEqual([
      '> "e\\nvil"/ -> "e\\nvil2"/',
      '~ "e\\nvil.f"  content changed (3 B -> 3 B)',
      "~ f  mode 0644 -> 0755",
      '~ l  link target "a\\x1B[2K" -> b',
      "~ t/  type file -> directory",
      '+ "t/e\\nvil"',
    ]);
    expect(r).not.toMatch(RAW_UNSAFE);
  });

  it("keeps the escaped-target label outside the quotes, where a real target can't imitate it", () => {
    const escaped = symlink(Uint8Array.of(0x61, 0xff));
    const imitation = symlink("a\\xFF (escaped: not valid UTF-8)");
    const line = (b: ReturnType<typeof symlink>, a: ReturnType<typeof symlink>) =>
      formatReport(diff(fromObject({ l: b }), fromObject({ l: a }))).split("\n")[0];
    expect(line(escaped, symlink("x"))).toBe('~ l  link target "a\\xFF" (escaped: not valid UTF-8) -> x');
    expect(line(imitation, symlink("x"))).toBe('~ l  link target "a\\\\xFF (escaped: not valid UTF-8)" -> x');
  });
});

describe("formatReport never prints two different changes the same way", () => {
  const report = (before: Parameters<typeof fromObject>[0], after: Parameters<typeof fromObject>[0], options = {}) =>
    formatReport(diff(fromObject(before), fromObject(after), options)).split("\n")[0];

  it("two different moves through names containing ->", () => {
    const one = report({ "a -> b": "x" }, { c: "x" });
    const two = report({ a: "x" }, { "b -> c": "x" });
    expect([one, two]).toEqual(['> "a -> b" -> c', '> a -> "b -> c"']);
  });

  it("a type change of a file named like a link-target line, and a real link-target change", () => {
    const name = "l  link target a -> x";
    const typeChange = report({ [name]: "1" }, { [name]: symlink("t") });
    const linkChange = report({ l: symlink("a") }, { l: symlink("x  type file -> symlink") });
    expect([typeChange, linkChange]).toEqual([
      '~ "l  link target a -> x"  type file -> symlink',
      '~ l  link target a -> "x  type file -> symlink"',
    ]);
  });

  it("a mode change of a file named like a content-change line, and a real content change", () => {
    const name = "f  content changed (1 B -> 1 B)";
    const metadata = report({ [name]: file("1", { mode: 0o644 }) }, { [name]: file("1", { mode: 0o755 }) });
    const content = report({ f: "1" }, { f: "2" });
    expect([metadata, content]).toEqual(['~ "f  content changed (1 B -> 1 B)"  mode 0644 -> 0755', "~ f  content changed (1 B -> 1 B)"]);
  });

  it("names that differ only in leading or trailing spaces", () => {
    expect([report({}, { a: "1" }), report({}, { "a ": "1" }), report({}, { " a": "1" })]).toEqual(["+ a", '+ "a "', '+ " a"']);
  });
});
