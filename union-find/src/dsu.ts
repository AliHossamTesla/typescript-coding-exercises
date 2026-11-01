/**
 * Disjoint-set union (union-find) over the integer elements `0 .. n-1`.
 *
 * - Union by size: the root of the smaller set is attached under the root of
 *   the larger one. On a tie, the root of the first argument stays the root.
 * - Full path compression: `find` makes every node on the visited path point
 *   directly at the root.
 *
 * Together these give O(α(n)) amortized time per operation, and O(n) space.
 */
export class DSU {
  /** Largest supported `n`: sizes and parent indices are stored as int32. */
  static readonly MAX_ELEMENTS = 0x7fffffff;

  /** Number of elements in the universe; valid elements are `0 .. n-1`. */
  readonly n: number;

  // Invariant: every public method validates elements via #check(x) before
  // accessing array slots, and all parent links remain within [0, n). Under
  // `noUncheckedIndexedAccess`, typed array lookups type as `number | undefined`;
  // `!` non-null assertions are used because indices are guaranteed in-bounds.
  /** `#parent[x]` is the parent of `x`; `x` is a root iff `#parent[x] === x`. */
  readonly #parent: Int32Array;

  /** `#setSize[r]` is the size of the set rooted at `r`. Only valid for roots. */
  readonly #setSize: Int32Array;

  #count: number;

  /**
   * Creates `n` singleton sets `{0}, {1}, ..., {n-1}`.
   *
   * @throws {RangeError} if `n` is not an integer in `[0, DSU.MAX_ELEMENTS]`.
   */
  constructor(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > DSU.MAX_ELEMENTS) {
      throw new RangeError(
        `DSU size must be an integer in [0, ${DSU.MAX_ELEMENTS}], got ${String(n)}`,
      );
    }
    this.n = n;
    this.#parent = new Int32Array(n);
    this.#setSize = new Int32Array(n);
    this.#count = n;
    this.clear();
  }

  /** Number of disjoint sets currently in the structure. */
  get count(): number {
    return this.#count;
  }

  /**
   * Returns the representative (root) of the set containing `x`, compressing
   * the path from `x` to the root.
   *
   * @throws {RangeError} if `x` is not an integer in `[0, n)`.
   */
  find(x: number): number {
    this.#check(x);
    return this.#findRoot(x);
  }

  /**
   * Returns `true` iff `a` and `b` are in the same set.
   *
   * @throws {RangeError} if `a` or `b` is not an integer in `[0, n)`.
   */
  connected(a: number, b: number): boolean {
    this.#check(a);
    this.#check(b);
    return this.#findRoot(a) === this.#findRoot(b);
  }

  /**
   * Returns the size of the set containing `x`.
   *
   * @throws {RangeError} if `x` is not an integer in `[0, n)`.
   */
  size(x: number): number {
    this.#check(x);
    return this.#setSize[this.#findRoot(x)]!;
  }

  /**
   * Merges the sets containing `a` and `b`.
   *
   * @returns `true` if two different sets were merged, `false` if `a` and `b`
   *   were already in the same set (including `a === b`).
   * @throws {RangeError} if `a` or `b` is not an integer in `[0, n)`.
   */
  union(a: number, b: number): boolean {
    this.#check(a);
    this.#check(b);
    let rootA = this.#findRoot(a);
    let rootB = this.#findRoot(b);
    if (rootA === rootB) return false;
    if (this.#setSize[rootA]! < this.#setSize[rootB]!) {
      [rootA, rootB] = [rootB, rootA];
    }
    this.#setSize[rootA]! += this.#setSize[rootB]!;
    this.#parent[rootB] = rootA;
    this.#count--;
    return true;
  }

  /** Resets the structure back to `n` singleton sets. */
  clear(): void {
    this.#setSize.fill(1);
    for (let i = 0; i < this.n; i++) this.#parent[i] = i;
    this.#count = this.n;
  }

  /**
   * Returns the height of the tallest tree (0 when every set is a singleton
   * or `n === 0`).
   *
   * Diagnostic method for testing and debugging: it walks the parent array
   * WITHOUT path compression and does not modify any state. O(n) time: each
   * node's depth is computed once and memoized in a temporary O(n) buffer.
   */
  maxDepth(): number {
    const depth = new Int32Array(this.n).fill(-1);
    const path: number[] = [];
    let max = 0;
    for (let x = 0; x < this.n; x++) {
      let node = x;
      while (depth[node] === -1 && this.#parent[node] !== node) {
        path.push(node);
        node = this.#parent[node]!;
      }
      if (depth[node] === -1) depth[node] = 0; // an unvisited root
      let nodeDepth = depth[node]!;
      while (path.length > 0) depth[path.pop()!] = ++nodeDepth;
      if (nodeDepth > max) max = nodeDepth;
    }
    return max;
  }

  /**
   * Recursive find with full path compression, without bounds checks.
   * Recursion depth is at most the tree height, which union by size keeps
   * at or below floor(log2(n)) <= 30, so it cannot overflow the stack.
   */
  #findRoot(x: number): number {
    const parentOfX = this.#parent[x]!;
    return parentOfX === x ? x : (this.#parent[x] = this.#findRoot(parentOfX));
  }

  #check(x: number): void {
    if (!Number.isInteger(x) || x < 0 || x >= this.n) {
      throw new RangeError(
        `Element must be an integer in [0, ${this.n}), got ${String(x)}`,
      );
    }
  }
}
