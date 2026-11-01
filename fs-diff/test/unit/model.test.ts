import { describe, expect, it } from "vitest";
import { compareNames, makeDirectory, sha256, type FileNode } from "../../src/model.js";

const file = (name: string, content: string, mode = 0o644): FileNode => ({
  type: "file",
  name,
  size: Buffer.byteLength(content),
  mtimeMs: 0,
  mode,
  contentHash: sha256(content),
});

describe("model", () => {
  it("sorts children by name and hashes deterministically regardless of insertion order", () => {
    const a = makeDirectory("d", 0o755, [file("b", "2"), file("a", "1"), file("c", "3")]);
    const b = makeDirectory("d", 0o755, [file("c", "3"), file("a", "1"), file("b", "2")]);
    expect(a.children.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(a.hash).toBe(b.hash);
  });

  it("does not include the directory's own name in its hash", () => {
    expect(makeDirectory("x", 0o755, [file("a", "1")]).hash).toBe(makeDirectory("y", 0o755, [file("a", "1")]).hash);
  });

  it("changes the hash when a child's content, name or mode changes", () => {
    const base = makeDirectory("d", 0o755, [file("a", "1")]).hash;
    expect(makeDirectory("d", 0o755, [file("a", "2")]).hash).not.toBe(base);
    expect(makeDirectory("d", 0o755, [file("b", "1")]).hash).not.toBe(base);
    expect(makeDirectory("d", 0o755, [file("a", "1", 0o755)]).hash).not.toBe(base);
  });

  it("rejects duplicate names", () => {
    expect(() => makeDirectory("d", 0o755, [file("a", "1"), file("a", "2")])).toThrow(/duplicate/);
  });

  it("orders names by code unit, not locale", () => {
    expect(["b", "B", "a", "é", "Z"].sort(compareNames)).toEqual(["B", "Z", "a", "b", "é"]);
  });
});
