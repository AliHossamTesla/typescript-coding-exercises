import { describe, expect, it } from "vitest";
import { GenericDSU } from "../../src/generic-dsu.js";

const PEOPLE = ["alice", "bob", "carol", "dave", "eve"];

describe("GenericDSU construction", () => {
  it("starts with one singleton per key: count = keys, find(key) === key, size 1", () => {
    const dsu = new GenericDSU(PEOPLE);
    expect(dsu.count).toBe(5);
    expect(dsu.maxDepth()).toBe(0);
    for (const person of PEOPLE) {
      expect(dsu.find(person)).toBe(person);
      expect(dsu.size(person)).toBe(1);
    }
  });

  it("accepts any iterable of keys (Set, generator)", () => {
    function* keys() {
      yield "x";
      yield "y";
    }
    expect(new GenericDSU(new Set(["a", "b", "c"])).count).toBe(3);
    expect(new GenericDSU(keys()).count).toBe(2);
  });

  it("accepts an empty key list: count 0 and every key is unknown", () => {
    const dsu = new GenericDSU<string>([]);
    expect(dsu.count).toBe(0);
    expect(dsu.maxDepth()).toBe(0);
    expect(() => dsu.find("a")).toThrow(RangeError);
  });

  it("rejects duplicate keys with a RangeError naming the key", () => {
    expect(() => new GenericDSU(["a", "b", "a"])).toThrow(RangeError);
    expect(() => new GenericDSU(["a", "b", "a"])).toThrow(/Duplicate key: a/);
  });

  it("treats 0 and -0 as the same key (SameValueZero), so [0, -0] is a duplicate", () => {
    expect(() => new GenericDSU([0, -0])).toThrow(/Duplicate key: 0/);
  });
});

describe("GenericDSU key types", () => {
  it("string keys: union, connected, size and count follow the merges", () => {
    const dsu = new GenericDSU(PEOPLE);
    expect(dsu.union("alice", "bob")).toBe(true);
    expect(dsu.union("bob", "carol")).toBe(true);
    expect(dsu.union("carol", "alice")).toBe(false);
    expect(dsu.union("eve", "eve")).toBe(false);
    expect(dsu.connected("alice", "carol")).toBe(true);
    expect(dsu.connected("alice", "dave")).toBe(false);
    expect(dsu.size("carol")).toBe(3);
    expect(dsu.size("dave")).toBe(1);
    expect(dsu.count).toBe(3);
  });

  it("number keys that are not 0..n-1 (e.g. 10, 20, 30) are mapped correctly", () => {
    const dsu = new GenericDSU([10, 20, 30]);
    dsu.union(30, 10);
    expect(dsu.connected(10, 30)).toBe(true);
    expect(dsu.find(10)).toBe(30); // tie -> first argument's root
    expect(() => dsu.find(0)).toThrow(RangeError);
  });

  it("object keys are compared by identity: two equal-looking objects stay distinct", () => {
    const first = { id: 1 };
    const second = { id: 1 };
    const dsu = new GenericDSU([first, second]);
    expect(dsu.count).toBe(2);
    expect(dsu.connected(first, second)).toBe(false);
    expect(dsu.find(second)).toBe(second);
    expect(() => dsu.find({ id: 1 })).toThrow(RangeError);
  });

  it("NaN works as a key (SameValueZero): find(NaN) returns NaN", () => {
    const dsu = new GenericDSU([Number.NaN, 1]);
    expect(dsu.has(Number.NaN)).toBe(true);
    expect(dsu.find(Number.NaN)).toBeNaN();
    dsu.union(Number.NaN, 1);
    expect(dsu.connected(1, Number.NaN)).toBe(true);
  });

  it("-0 finds the key 0 (SameValueZero)", () => {
    const dsu = new GenericDSU([0, 1]);
    expect(dsu.has(-0)).toBe(true);
    expect(dsu.find(-0)).toBe(0);
  });
});

describe("GenericDSU API", () => {
  it("find returns a key, not an index: union('y', 'x') makes 'y' the representative", () => {
    const dsu = new GenericDSU(["x", "y"]);
    dsu.union("y", "x");
    expect(dsu.find("x")).toBe("y");
  });

  it("has() is true for known keys and false for unknown ones", () => {
    const dsu = new GenericDSU(PEOPLE);
    expect(dsu.has("alice")).toBe(true);
    expect(dsu.has("mallory")).toBe(false);
  });

  it("clear() resets to singletons and keeps the same keys", () => {
    const dsu = new GenericDSU(PEOPLE);
    dsu.union("alice", "bob");
    dsu.union("carol", "dave");
    dsu.clear();
    expect(dsu.count).toBe(5);
    expect(dsu.maxDepth()).toBe(0);
    for (const person of PEOPLE) {
      expect(dsu.has(person)).toBe(true);
      expect(dsu.find(person)).toBe(person);
      expect(dsu.size(person)).toBe(1);
    }
    expect(dsu.has("mallory")).toBe(false);
    expect(dsu.union("alice", "bob")).toBe(true);
  });

  it("maxDepth() is 3 for a binomial tree built on 8 string keys", () => {
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const dsu = new GenericDSU(keys);
    for (let step = 1; step < 8; step *= 2) {
      for (let i = 0; i < 8; i += 2 * step) dsu.union(`k${i}`, `k${i + step}`);
    }
    expect(dsu.maxDepth()).toBe(3);
  });
});

describe("GenericDSU unknown keys", () => {
  const calls: Array<[string, (dsu: GenericDSU<string>) => unknown]> = [
    ["find(unknown)", (dsu) => dsu.find("mallory")],
    ["size(unknown)", (dsu) => dsu.size("mallory")],
    ["union(unknown, known)", (dsu) => dsu.union("mallory", "carol")],
    ["union(known, unknown)", (dsu) => dsu.union("carol", "mallory")],
    ["connected(unknown, known)", (dsu) => dsu.connected("mallory", "carol")],
    ["connected(known, unknown)", (dsu) => dsu.connected("carol", "mallory")],
  ];

  it.each(calls)("%s throws RangeError 'Unknown key' and leaves state unchanged", (_name, call) => {
    const dsu = new GenericDSU(PEOPLE);
    dsu.union("alice", "bob"); // {alice, bob} root alice
    dsu.union("carol", "alice"); // {carol} is smaller -> carol under alice at depth 1
    dsu.union("dave", "eve"); // {dave, eve} root dave
    dsu.union("alice", "dave"); // {dave, eve} under alice: eve at depth 2
    expect(() => call(dsu)).toThrow(RangeError);
    expect(() => call(dsu)).toThrow(/Unknown key: mallory/);
    expect(dsu.maxDepth()).toBe(2);
    expect(dsu.count).toBe(1);
    for (const person of PEOPLE) {
      expect(dsu.find(person)).toBe("alice");
      expect(dsu.size(person)).toBe(5);
    }
  });
});
