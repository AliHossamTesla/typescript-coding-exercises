import { describe, expect, it } from "vitest";
import { DSU } from "../../src/dsu.js";
import { DSU as EntryDSU, GenericDSU as EntryGenericDSU } from "../../src/index.js";
import { GenericDSU } from "../../src/generic-dsu.js";
import { buildBinomialTree, mulberry32 } from "../helpers.js";

/** Values that are not valid elements of a DSU of size 10. */
const INVALID_ELEMENTS: unknown[] = [
  -1, 10, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  "1", null, undefined,
];
const ELEMENT_ERROR = /Element must be an integer in \[0, 10\), got /;

/**
 * Fixture with a known, hand-derived shape on n = 10:
 * a binomial tree on 0..7 (root 0, height 3, unique deepest leaf 7) and {8, 9} (root 8).
 */
function buildFixture(): DSU {
  const dsu = new DSU(10);
  buildBinomialTree(dsu, 3);
  dsu.union(8, 9);
  return dsu;
}

/**
 * Asserts the fixture is exactly as built. maxDepth is checked FIRST: it does not
 * compress, so it proves no `find` ran on the deepest path (that would lower it to 2).
 */
function expectFixtureUnchanged(dsu: DSU): void {
  expect(dsu.maxDepth()).toBe(3);
  expect(dsu.count).toBe(2);
  const expectedRoots = [0, 0, 0, 0, 0, 0, 0, 0, 8, 8];
  const expectedSizes = [8, 8, 8, 8, 8, 8, 8, 8, 2, 2];
  for (let x = 0; x < 10; x++) {
    expect(dsu.find(x)).toBe(expectedRoots[x]);
    expect(dsu.size(x)).toBe(expectedSizes[x]);
  }
}

describe("public entry point", () => {
  it("index re-exports DSU and GenericDSU and works as expected", () => {
    expect(EntryDSU).toBe(DSU);
    expect(EntryGenericDSU).toBe(GenericDSU);
    const dsu = new EntryDSU(2);
    expect(dsu.union(0, 1)).toBe(true);
    expect(dsu.connected(0, 1)).toBe(true);
    const generic = new EntryGenericDSU(["a", "b"]);
    expect(generic.union("a", "b")).toBe(true);
    expect(generic.connected("a", "b")).toBe(true);
  });
});

describe("constructor", () => {
  it("n = 0 gives an empty structure with count 0 where every element call throws", () => {
    const dsu = new DSU(0);
    expect(dsu.n).toBe(0);
    expect(dsu.count).toBe(0);
    expect(dsu.maxDepth()).toBe(0);
    expect(() => dsu.find(0)).toThrow(RangeError);
    expect(() => dsu.size(0)).toThrow(RangeError);
    expect(() => dsu.union(0, 0)).toThrow(RangeError);
    expect(() => dsu.connected(0, 0)).toThrow(RangeError);
  });

  it("n = 1 gives one singleton that is its own root and rejects element 1", () => {
    const dsu = new DSU(1);
    expect(dsu.count).toBe(1);
    expect(dsu.find(0)).toBe(0);
    expect(dsu.size(0)).toBe(1);
    expect(dsu.connected(0, 0)).toBe(true);
    expect(dsu.union(0, 0)).toBe(false);
    expect(dsu.maxDepth()).toBe(0);
    expect(() => dsu.find(1)).toThrow(RangeError);
  });

  it("n = 5 gives 5 singletons, each its own root with size 1", () => {
    const dsu = new DSU(5);
    expect(dsu.n).toBe(5);
    expect(dsu.count).toBe(5);
    for (let x = 0; x < 5; x++) {
      expect(dsu.find(x)).toBe(x);
      expect(dsu.size(x)).toBe(1);
    }
  });

  it("exposes MAX_ELEMENTS = 2^31 - 1 as the largest allowed n", () => {
    expect(DSU.MAX_ELEMENTS).toBe(2 ** 31 - 1);
  });

  it.each([
    -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 31,
    "5", null, undefined,
  ] as unknown[])("rejects n = %s with a RangeError naming the valid range", (n) => {
    expect(() => new DSU(n as number)).toThrow(RangeError);
    expect(() => new DSU(n as number)).toThrow(
      /DSU size must be an integer in \[0, 2147483647\], got /,
    );
  });
});

describe("element validation", () => {
  const methods: Array<[string, (dsu: DSU, bad: number) => unknown]> = [
    ["find(bad)", (dsu, bad) => dsu.find(bad)],
    ["size(bad)", (dsu, bad) => dsu.size(bad)],
    ["union(bad, 7)", (dsu, bad) => dsu.union(bad, 7)],
    ["union(7, bad)", (dsu, bad) => dsu.union(7, bad)],
    ["connected(bad, 7)", (dsu, bad) => dsu.connected(bad, 7)],
    ["connected(7, bad)", (dsu, bad) => dsu.connected(7, bad)],
  ];

  describe.each(methods)("%s", (_name, call) => {
    it.each(INVALID_ELEMENTS)("throws RangeError for %s and leaves state unchanged", (bad) => {
      const dsu = buildFixture();
      expect(() => call(dsu, bad as number)).toThrow(RangeError);
      expect(() => call(dsu, bad as number)).toThrow(ELEMENT_ERROR);
      expectFixtureUnchanged(dsu);
    });
  });
});

describe("find", () => {
  it("returns the element itself for a singleton", () => {
    const dsu = new DSU(3);
    expect(dsu.find(2)).toBe(2);
  });

  it("returns the same root for every member after unions", () => {
    const dsu = new DSU(6);
    dsu.union(0, 1); // tie -> root 0
    dsu.union(2, 3); // tie -> root 2
    dsu.union(1, 3); // tie of sizes 2 and 2 -> root of first argument: 0
    for (const x of [0, 1, 2, 3]) expect(dsu.find(x)).toBe(0);
    expect(dsu.find(4)).toBe(4);
    expect(dsu.find(5)).toBe(5);
  });

  it("path compression: find on the deepest leaf of a height-3 tree lowers the height to 2", () => {
    // Binomial tree on 0..7. Path from 7: 7 -> 6 -> 4 -> 0. Without compression
    // the height stays 3. With full compression 7 and 6 point at 0, and the
    // deepest nodes become 3 (3 -> 2 -> 0) and 5 (5 -> 4 -> 0) at depth 2.
    const dsu = new DSU(8);
    buildBinomialTree(dsu, 3);
    expect(dsu.maxDepth()).toBe(3);
    expect(dsu.find(7)).toBe(0);
    expect(dsu.maxDepth()).toBe(2);
  });

  it("path compression: after find on every element every node points directly at the root", () => {
    const dsu = new DSU(16);
    buildBinomialTree(dsu, 4);
    expect(dsu.maxDepth()).toBe(4);
    for (let x = 0; x < 16; x++) expect(dsu.find(x)).toBe(0);
    expect(dsu.maxDepth()).toBe(1);
  });

  it("is idempotent: repeated find gives the same root and find(find(x)) === find(x)", () => {
    const dsu = new DSU(8);
    buildBinomialTree(dsu, 3);
    expect(dsu.find(7)).toBe(0);
    expect(dsu.find(7)).toBe(0);
    for (let x = 0; x < 8; x++) expect(dsu.find(dsu.find(x))).toBe(0);
  });
});

describe("union", () => {
  it("returns true on a real merge, false on a repeated merge, false on self-union", () => {
    const dsu = new DSU(3);
    expect(dsu.union(0, 1)).toBe(true);
    expect(dsu.union(0, 1)).toBe(false);
    expect(dsu.union(1, 0)).toBe(false);
    expect(dsu.union(2, 2)).toBe(false);
  });

  it("count drops by exactly 1 on each true merge and is unchanged otherwise", () => {
    const dsu = new DSU(5);
    const steps: Array<[number, number, boolean, number]> = [
      // a, b, expected return, expected count after
      [0, 1, true, 4],
      [1, 0, false, 4],
      [3, 3, false, 4],
      [2, 3, true, 3],
      [0, 3, true, 2],
      [1, 2, false, 2],
      [4, 0, true, 1],
      [4, 2, false, 1],
    ];
    for (const [a, b, merged, countAfter] of steps) {
      expect(dsu.union(a, b)).toBe(merged);
      expect(dsu.count).toBe(countAfter);
    }
  });

  it("union by size: the smaller set's root goes under the larger set's root (smaller as first argument)", () => {
    const dsu = new DSU(5);
    dsu.union(0, 1);
    dsu.union(0, 2); // {0,1,2} root 0
    dsu.union(3, 4); // {3,4} root 3
    expect(dsu.union(3, 0)).toBe(true);
    expect(dsu.maxDepth()).toBe(2); // 4 -> 3 -> 0, checked before find compresses it
    expect(dsu.find(3)).toBe(0);
    expect(dsu.find(4)).toBe(0);
  });

  it("union by size: the smaller set's root goes under the larger set's root (smaller as second argument)", () => {
    const dsu = new DSU(5);
    dsu.union(0, 1);
    dsu.union(0, 2); // {0,1,2} root 0
    dsu.union(3, 4); // {3,4} root 3
    expect(dsu.union(0, 3)).toBe(true);
    expect(dsu.find(3)).toBe(0);
    expect(dsu.find(4)).toBe(0);
  });

  it("union by size: a singleton joining a larger set never becomes the root", () => {
    const dsu = new DSU(4);
    dsu.union(0, 1);
    dsu.union(2, 0); // {2} is smaller than {0,1}
    expect(dsu.find(2)).toBe(0);
    dsu.union(0, 3);
    expect(dsu.find(3)).toBe(0);
  });

  it("tie-break: equal singletons keep the first argument's root", () => {
    const dsu = new DSU(4);
    dsu.union(3, 2);
    expect(dsu.find(2)).toBe(3);
    expect(dsu.find(3)).toBe(3);
  });

  it("tie-break: equal sets of size 2 keep the first argument's root (union(1, 3) -> root 0)", () => {
    const dsu = new DSU(4);
    dsu.union(0, 1); // root 0
    dsu.union(2, 3); // root 2
    dsu.union(1, 3);
    for (const x of [0, 1, 2, 3]) expect(dsu.find(x)).toBe(0);
  });

  it("tie-break: equal sets of size 2 keep the first argument's root (union(3, 1) -> root 2)", () => {
    const dsu = new DSU(4);
    dsu.union(0, 1); // root 0
    dsu.union(2, 3); // root 2
    dsu.union(3, 1);
    for (const x of [0, 1, 2, 3]) expect(dsu.find(x)).toBe(2);
  });

  it("merging two big sets of 1000 gives one set of 2000 rooted at the first argument's root", () => {
    const dsu = new DSU(2000);
    for (let i = 0; i < 999; i++) dsu.union(i, i + 1); // root 0
    for (let i = 1000; i < 1999; i++) dsu.union(i, i + 1); // root 1000
    expect(dsu.count).toBe(2);
    expect(dsu.union(500, 1500)).toBe(true);
    expect(dsu.count).toBe(1);
    expect(dsu.size(1999)).toBe(2000);
    expect(dsu.find(1999)).toBe(0);
    expect(dsu.union(999, 1999)).toBe(false);
  });

  it("merging a set with itself through different members returns false and changes nothing", () => {
    const dsu = new DSU(4);
    buildBinomialTree(dsu, 2); // {0,1,2,3}, height 2
    expect(dsu.union(1, 3)).toBe(false);
    expect(dsu.union(3, 2)).toBe(false);
    expect(dsu.count).toBe(1);
    expect(dsu.size(0)).toBe(4);
  });
});

describe("connected / size / count", () => {
  // Partition of 0..8 built by the unions below: {0,3,6} {1,4} {2} {5,7,8}.
  const label = [0, 1, 2, 0, 1, 3, 0, 3, 3];
  const groupSize = [3, 2, 1, 3];
  function buildPartition(): DSU {
    const dsu = new DSU(9);
    for (const [a, b] of [[0, 3], [3, 6], [1, 4], [7, 5], [8, 7]] as const) dsu.union(a, b);
    return dsu;
  }

  it("connected matches the expected partition for every ordered pair", () => {
    const dsu = buildPartition();
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 9; b++) expect(dsu.connected(a, b)).toBe(label[a] === label[b]);
    }
  });

  it("connected is reflexive: connected(x, x) is true for every x", () => {
    const dsu = buildPartition();
    for (let x = 0; x < 9; x++) expect(dsu.connected(x, x)).toBe(true);
  });

  it("connected is symmetric: connected(a, b) === connected(b, a)", () => {
    const dsu = buildPartition();
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 9; b++) {
        const expected = label[a] === label[b];
        expect(dsu.connected(a, b)).toBe(expected);
        expect(dsu.connected(b, a)).toBe(expected);
      }
    }
  });

  it("connected is transitive: connected(a, b) and connected(b, c) imply connected(a, c)", () => {
    const dsu = buildPartition();
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 9; b++) {
        for (let c = 0; c < 9; c++) {
          if (label[a] === label[b] && label[b] === label[c]) {
            expect(dsu.connected(a, b) && dsu.connected(b, c)).toBe(true);
            expect(dsu.connected(a, c)).toBe(true);
          }
        }
      }
    }
  });

  it("size is correct for every member of a set, not just the root", () => {
    const dsu = buildPartition();
    for (let x = 0; x < 9; x++) expect(dsu.size(x)).toBe(groupSize[label[x]!]);
  });

  it("count equals the number of groups in the partition (4)", () => {
    expect(buildPartition().count).toBe(4);
  });

  it("after 300 seeded random unions on n = 500, root sizes sum to n and count equals the number of roots", () => {
    const random = mulberry32(99);
    const dsu = new DSU(500);
    for (let i = 0; i < 300; i++) {
      dsu.union(Math.floor(random() * 500), Math.floor(random() * 500));
    }
    let roots = 0;
    let sizeSum = 0;
    for (let x = 0; x < 500; x++) {
      if (dsu.find(x) === x) {
        roots++;
        sizeSum += dsu.size(x);
      }
    }
    expect(sizeSum).toBe(500);
    expect(dsu.count).toBe(roots);
  });

  it("count goes from n down to 1, one step per merge, when everything is merged", () => {
    const n = 50;
    const dsu = new DSU(n);
    expect(dsu.count).toBe(n);
    for (let i = 0; i + 1 < n; i++) {
      dsu.union(i + 1, i);
      expect(dsu.count).toBe(n - 1 - i);
    }
    expect(dsu.count).toBe(1);
    expect(dsu.size(0)).toBe(n);
  });
});

describe("clear", () => {
  it("resets to n singletons: count = n, every size 1, every element its own root, maxDepth 0", () => {
    const dsu = new DSU(16);
    buildBinomialTree(dsu, 4);
    dsu.clear();
    expect(dsu.count).toBe(16);
    expect(dsu.maxDepth()).toBe(0);
    for (let x = 0; x < 16; x++) {
      expect(dsu.find(x)).toBe(x);
      expect(dsu.size(x)).toBe(1);
    }
  });

  it("the structure works normally after clear (unions, sizes, tie-break)", () => {
    const dsu = new DSU(4);
    dsu.union(0, 1);
    dsu.clear();
    expect(dsu.union(1, 0)).toBe(true);
    expect(dsu.find(0)).toBe(1);
    expect(dsu.size(0)).toBe(2);
    expect(dsu.count).toBe(3);
  });

  it("can be cleared twice in a row, and on an empty structure", () => {
    const dsu = new DSU(3);
    dsu.union(0, 2);
    dsu.clear();
    dsu.clear();
    expect(dsu.count).toBe(3);
    expect(dsu.connected(0, 2)).toBe(false);
    const empty = new DSU(0);
    empty.clear();
    expect(empty.count).toBe(0);
  });
});

describe("maxDepth", () => {
  it("is 0 for n = 0 and for all singletons", () => {
    expect(new DSU(0).maxDepth()).toBe(0);
    expect(new DSU(7).maxDepth()).toBe(0);
  });

  it("is 1 after one union of two singletons", () => {
    const dsu = new DSU(2);
    dsu.union(0, 1);
    expect(dsu.maxDepth()).toBe(1);
  });

  it.each([1, 2, 3, 4])("is exactly k for the binomial tree on 2^k elements (k = %i)", (k) => {
    const dsu = new DSU(2 ** k);
    buildBinomialTree(dsu, k);
    expect(dsu.maxDepth()).toBe(k);
  });

  it("is the height of the tallest tree when trees of different heights coexist (3 and 1)", () => {
    expect(buildFixture().maxDepth()).toBe(3);
  });

  it("does not change state: repeated calls return the same height and the tree stays uncompressed", () => {
    const dsu = buildFixture();
    expect(dsu.maxDepth()).toBe(3);
    expect(dsu.maxDepth()).toBe(3);
    expectFixtureUnchanged(dsu);
  });
});
