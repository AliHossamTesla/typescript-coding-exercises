import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DSU } from "../../src/dsu.js";
import { GenericDSU } from "../../src/generic-dsu.js";
import { NaiveConnectivity, propertyParams } from "../helpers.js";

interface Operation {
  kind: "union" | "connected";
  a: number;
  b: number;
}

/** A random universe size n and a random sequence of operations on 0..n-1. */
function scenario(maxN: number, maxOps: number) {
  return fc.integer({ min: 1, max: maxN }).chain((n) =>
    fc.record({
      n: fc.constant(n),
      ops: fc.array(
        fc.record({
          kind: fc.constantFrom<Operation["kind"]>("union", "connected"),
          a: fc.integer({ min: 0, max: n - 1 }),
          b: fc.integer({ min: 0, max: n - 1 }),
        }),
        { maxLength: maxOps },
      ),
    }),
  );
}

describe("property: DSU matches a naive BFS reference", () => {
  it("same union return values, connected answers and count after every op, same sizes at the end", () => {
    fc.assert(
      fc.property(scenario(64, 150), ({ n, ops }) => {
        const dsu = new DSU(n);
        const naive = new NaiveConnectivity(n);
        for (const { kind, a, b } of ops) {
          if (kind === "union") {
            expect(dsu.union(a, b)).toBe(!naive.connected(a, b));
            naive.addEdge(a, b);
          } else {
            expect(dsu.connected(a, b)).toBe(naive.connected(a, b));
          }
          expect(dsu.count).toBe(naive.componentCount());
        }
        for (let x = 0; x < n; x++) expect(dsu.size(x)).toBe(naive.component(x).size);
      }),
      propertyParams(),
    );
  });
});

describe("property: invariants hold after every op", () => {
  it("maxDepth <= floor(log2 n) after every op (no extra finds, so trees are not flattened by the check)", () => {
    fc.assert(
      fc.property(scenario(512, 600), ({ n, ops }) => {
        const dsu = new DSU(n);
        const bound = Math.floor(Math.log2(n));
        for (const { kind, a, b } of ops) {
          if (kind === "union") dsu.union(a, b);
          else dsu.connected(a, b);
          expect(dsu.maxDepth()).toBeLessThanOrEqual(bound);
        }
      }),
      propertyParams(100),
    );
  });

  it("sizes of all roots sum to n and count equals the number of roots after every op", () => {
    fc.assert(
      fc.property(scenario(64, 150), ({ n, ops }) => {
        const dsu = new DSU(n);
        for (const { kind, a, b } of ops) {
          if (kind === "union") dsu.union(a, b);
          else dsu.connected(a, b);
          let roots = 0;
          let sizeSum = 0;
          for (let x = 0; x < n; x++) {
            if (dsu.find(x) === x) {
              roots++;
              sizeSum += dsu.size(x);
            }
          }
          expect(sizeSum).toBe(n);
          expect(dsu.count).toBe(roots);
        }
      }),
      propertyParams(),
    );
  });
});

describe("property: GenericDSU matches DSU and the BFS reference", () => {
  it("same union/connected answers, count, sizes and representatives (as keys) on string keys", () => {
    fc.assert(
      fc.property(scenario(64, 150), ({ n, ops }) => {
        const key = (i: number) => `key-${i}`;
        const generic = new GenericDSU(Array.from({ length: n }, (_, i) => key(i)));
        const core = new DSU(n);
        const naive = new NaiveConnectivity(n);
        for (const { kind, a, b } of ops) {
          if (kind === "union") {
            const expected = !naive.connected(a, b);
            naive.addEdge(a, b);
            expect(core.union(a, b)).toBe(expected);
            expect(generic.union(key(a), key(b))).toBe(expected);
          } else {
            const expected = naive.connected(a, b);
            expect(core.connected(a, b)).toBe(expected);
            expect(generic.connected(key(a), key(b))).toBe(expected);
          }
          expect(generic.count).toBe(naive.componentCount());
        }
        expect(generic.maxDepth()).toBe(core.maxDepth());
        for (let x = 0; x < n; x++) {
          expect(generic.size(key(x))).toBe(naive.component(x).size);
          expect(generic.find(key(x))).toBe(key(core.find(x)));
        }
      }),
      propertyParams(),
    );
  });
});
