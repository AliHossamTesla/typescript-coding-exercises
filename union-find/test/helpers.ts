/**
 * Shared test helpers: a seeded PRNG, independent reference implementations,
 * and fast-check settings. Nothing here uses the code under test.
 */
import fc from "fast-check";

/** Deterministic 32-bit PRNG (mulberry32), so random tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Naive reference: an undirected graph whose questions are answered by BFS. */
export class NaiveConnectivity {
  readonly #adjacency: number[][];

  constructor(n: number) {
    this.#adjacency = Array.from({ length: n }, () => []);
  }

  addEdge(a: number, b: number): void {
    this.#adjacency[a]!.push(b);
    this.#adjacency[b]!.push(a);
  }

  /** Elements reachable from `start`, including `start` itself. */
  component(start: number): Set<number> {
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const next of this.#adjacency[queue[head]!]!) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  connected(a: number, b: number): boolean {
    return this.component(a).has(b);
  }

  componentCount(): number {
    const seen = new Set<number>();
    let components = 0;
    for (let x = 0; x < this.#adjacency.length; x++) {
      if (seen.has(x)) continue;
      components++;
      for (const y of this.component(x)) seen.add(y);
    }
    return components;
  }
}

/**
 * BFS component labelling over a compact (CSR) adjacency, for large inputs.
 * Returns each element's component label and each label's size.
 */
export function labelComponents(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
): { label: Int32Array; componentSize: number[] } {
  const degree = new Int32Array(n + 1);
  for (const [a, b] of edges) {
    degree[a + 1]!++;
    degree[b + 1]!++;
  }
  for (let i = 0; i < n; i++) degree[i + 1]! += degree[i]!;
  const offset = degree.slice();
  const neighbours = new Int32Array(2 * edges.length);
  for (const [a, b] of edges) {
    neighbours[offset[a]!++] = b;
    neighbours[offset[b]!++] = a;
  }
  const label = new Int32Array(n).fill(-1);
  const componentSize: number[] = [];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1) continue;
    const id = componentSize.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const node = queue[head++]!;
      for (let i = degree[node]!; i < degree[node + 1]!; i++) {
        const next = neighbours[i]!;
        if (label[next] === -1) {
          label[next] = id;
          queue[tail++] = next;
        }
      }
    }
    componentSize.push(tail);
  }
  return { label, componentSize };
}

/** Minimal shape shared by DSU and the unions we need from it. */
interface Unionable {
  union(a: number, b: number): boolean;
}

/**
 * Builds the worst-case tree union by size allows: merge equal-sized blocks
 * root-to-root, producing a binomial tree on elements `0 .. 2^k - 1`.
 * Root is 0, height is exactly k, and the unique deepest leaf is 2^k - 1.
 */
export function buildBinomialTree(dsu: Unionable, k: number): void {
  const size = 2 ** k;
  for (let step = 1; step < size; step *= 2) {
    for (let i = 0; i < size; i += 2 * step) dsu.union(i, i + step);
  }
}

/** Reads an environment variable without depending on Node type definitions. */
function env(name: string): string | undefined {
  const runtime = globalThis as { process?: { env: Record<string, string | undefined> } };
  return runtime.process?.env[name];
}

/**
 * fast-check settings. Fixed seed by default; to replay a failure, set
 * FC_SEED (and optionally FC_PATH) to the values fast-check printed.
 */
export function propertyParams(numRuns = 200): fc.Parameters<unknown> {
  const path = env("FC_PATH");
  return {
    seed: Number(env("FC_SEED") ?? 20261031),
    numRuns: Number(env("FC_RUNS") ?? numRuns),
    ...(path === undefined ? {} : { path }),
  };
}
