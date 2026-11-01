import { describe, expect, it } from "vitest";
import { createIgnoreMatcher } from "../../src/ignore.js";

describe("ignore matcher", () => {
  const ignored = createIgnoreMatcher(["node_modules", ".git", "*.log", "build/cache", "docs/**/draft-*"]);
  it.each([
    ["node_modules", "node_modules", true],
    ["a/b/node_modules", "node_modules", true],
    ["src/app.log", "app.log", true],
    ["build/cache", "cache", true],
    ["other/build/cache", "cache", false],
    ["docs/draft-1", "draft-1", true],
    ["docs/x/y/draft-2", "draft-2", true],
    ["src/index.ts", "index.ts", false],
    ["node_modules_backup", "node_modules_backup", false],
  ])("%s -> %s", (relPath, name, expected) => {
    expect(ignored(relPath, name, false)).toBe(expected);
  });
});

describe("trailing-slash (directory-only) patterns", () => {
  const ignored = createIgnoreMatcher(["node_modules/", "/dist", "build/"]);

  it("match the directory at any depth", () => {
    expect(ignored("node_modules", "node_modules", true)).toBe(true);
    expect(ignored("sub/node_modules", "node_modules", true)).toBe(true);
  });

  it("do not match a file of the same name, like .gitignore", () => {
    expect(ignored("build", "build", false)).toBe(false);
    expect(ignored("build", "build", true)).toBe(true);
  });

  it("are anchored to the root when they start with a slash", () => {
    expect(ignored("dist", "dist", true)).toBe(true);
    expect(ignored("pkg/dist", "dist", true)).toBe(false);
  });
});

describe("backslash is a literal file name character, not a separator", () => {
  it("lets a POSIX name containing a backslash be ignored", () => {
    const ignored = createIgnoreMatcher(["weird\\name.txt"]);
    expect(ignored("weird\\name.txt", "weird\\name.txt", false)).toBe(true);
    expect(ignored("weird/name.txt", "name.txt", false)).toBe(false);
  });
});

describe("glob syntax", () => {
  it("? matches exactly one character, never /", () => {
    const ignored = createIgnoreMatcher(["file?.txt"]);
    expect(ignored("file1.txt", "file1.txt", false)).toBe(true);
    expect(ignored("file.txt", "file.txt", false)).toBe(false);
    expect(ignored("file12.txt", "file12.txt", false)).toBe(false);
    expect(createIgnoreMatcher(["a?b"])("a/b", "b", false)).toBe(false);
  });

  it("** not followed by / matches across folders", () => {
    const ignored = createIgnoreMatcher(["logs/**"]);
    expect(ignored("logs/a", "a", false)).toBe(true);
    expect(ignored("logs/a/b/c.txt", "c.txt", false)).toBe(true);
    expect(ignored("other/logs/a", "a", false)).toBe(false);
  });

  it("**/ also matches zero folders", () => {
    const ignored = createIgnoreMatcher(["a/**/b"]);
    expect(ignored("a/b", "b", false)).toBe(true);
    expect(ignored("a/x/y/b", "b", false)).toBe(true);
  });

  it("escapes regex characters, so they match only themselves", () => {
    const ignored = createIgnoreMatcher(["a+(b).[c]$"]);
    expect(ignored("a+(b).[c]$", "a+(b).[c]$", false)).toBe(true);
    expect(ignored("aa(b)x[c]", "aa(b)x[c]", false)).toBe(false);
  });

  it.each([[""], ["   "], ["/"], ["//"]])("skips the empty pattern %j instead of matching everything", (pattern) => {
    expect(createIgnoreMatcher([pattern])("anything", "anything", true)).toBe(false);
  });
});
