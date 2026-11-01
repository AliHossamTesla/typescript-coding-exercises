import { describe, expect, it } from "vitest";
import { DSU } from "../../src/dsu.js";
import { labelComponents, mulberry32 } from "../helpers.js";

const N = 1_000_000;

describe("scale: 10^6 elements", () => {
  it("a forward chain union(i, i+1) gives one set of 10^6, maxDepth 1", { timeout: 20_000 }, () => {
    const dsu = new DSU(N);
    let merges = 0;
    for (let i = 0; i + 1 < N; i++) if (dsu.union(i, i + 1)) merges++;
    expect(merges).toBe(N - 1);
    expect(merges).toBe(N - 1);
    expect(dsu.count).toBe(1);
    expect(dsu.maxDepth()).toBe(1);
    expect(dsu.size(N - 1)).toBe(N);
    expect(dsu.connected(0, N - 1)).toBe(true);
    expect(dsu.find(N - 1)).toBe(0);
  });

  it("a backward chain union(i, i-1) gives one set of 10^6 rooted at the first element merged (N-1)", { timeout: 20_000 }, () => {
    const dsu = new DSU(N);
    for (let i = N - 1; i > 0; i--) dsu.union(i, i - 1);
    expect(dsu.count).toBe(1);
    expect(dsu.maxDepth()).toBe(1);
    expect(dsu.find(0)).toBe(N - 1);
  });

  it("a seeded random workload (10^6 unions, 10^6 queries) matches CSR-BFS components", { timeout: 30_000 }, () => {
    const random = mulberry32(12345);
    const pick = () => Math.floor(random() * N);
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) edges.push([pick(), pick()]);
    const queries: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) queries.push([pick(), pick()]);

    const dsu = new DSU(N);
    for (const [a, b] of edges) dsu.union(a, b);
    const answers = queries.map(([a, b]) => dsu.connected(a, b));

    const { label, componentSize } = labelComponents(N, edges);
    expect(dsu.count).toBe(componentSize.length);
    let mismatches = 0;
    let positives = 0;
    queries.forEach(([a, b], i) => {
      const expected = label[a] === label[b];
      if (expected) positives++;
      if (answers[i] !== expected) mismatches++;
    });
    expect(mismatches).toBe(0);
    expect(positives).toBeGreaterThan(0); // the workload exercises both answers
    expect(positives).toBeLessThan(N);
    for (let i = 0; i < 1000; i++) {
      const x = pick();
      expect(dsu.size(x)).toBe(componentSize[label[x]!]);
    }
    expect(dsu.maxDepth()).toBeLessThanOrEqual(Math.floor(Math.log2(N)));
  });
});
