import { describe, expect, it } from "vitest";
import { DSU } from "../../src/dsu.js";
import { buildBinomialTree, mulberry32 } from "../helpers.js";

describe("height bounds", () => {
  it("worst case: the binomial tree on 2^20 elements reaches height exactly 20", { timeout: 20_000 }, () => {
    const dsu = new DSU(2 ** 20);
    buildBinomialTree(dsu, 20);
    expect(dsu.count).toBe(1);
    expect(dsu.maxDepth()).toBe(20);
  });

  it("find on the deepest leaf of the k = 20 tree (recursion depth 20) returns root 0 without stack overflow", { timeout: 20_000 }, () => {
    const dsu = new DSU(2 ** 20);
    buildBinomialTree(dsu, 20);
    expect(dsu.find(2 ** 20 - 1)).toBe(0);
    expect(dsu.maxDepth()).toBe(19); // that path is now flat, its siblings remain
  });

  it("after 4n seeded random unions on n = 2^16, maxDepth <= floor(log2 n) = 16", () => {
    const random = mulberry32(7);
    const n = 2 ** 16;
    const dsu = new DSU(n);
    for (let op = 0; op < 4 * n; op++) {
      dsu.union(Math.floor(random() * n), Math.floor(random() * n));
      if (op % 4096 === 0) expect(dsu.maxDepth()).toBeLessThanOrEqual(16);
    }
    expect(dsu.maxDepth()).toBeLessThanOrEqual(16);
  });

  it("a chain union(i, i+1) stays flat: maxDepth is exactly 1, because each new singleton goes under root 0", () => {
    const dsu = new DSU(100_000);
    for (let i = 0; i + 1 < 100_000; i++) dsu.union(i, i + 1);
    expect(dsu.maxDepth()).toBe(1);
  });
});
