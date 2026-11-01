import { DSU } from "./dsu.js";

/**
 * Union-find over arbitrary keys. A thin wrapper that maps each key to an
 * index with a `Map` and delegates to {@link DSU}.
 *
 * The set of keys is fixed at construction. Keys are compared like `Map`
 * keys (SameValueZero): primitives by value, objects by identity.
 */
export class GenericDSU<T> {
  readonly #indexOf = new Map<T, number>();
  readonly #keys: T[];
  readonly #dsu: DSU;

  /**
   * Creates one singleton set per key.
   *
   * @throws {RangeError} if `keys` contains a duplicate.
   */
  constructor(keys: Iterable<T>) {
    this.#keys = [...keys];
    for (const [index, key] of this.#keys.entries()) {
      if (this.#indexOf.has(key)) {
        throw new RangeError(`Duplicate key: ${String(key)}`);
      }
      this.#indexOf.set(key, index);
    }
    this.#dsu = new DSU(this.#keys.length);
  }

  /** Number of disjoint sets. */
  get count(): number {
    return this.#dsu.count;
  }

  /** Whether `key` belongs to the universe. */
  has(key: T): boolean {
    return this.#indexOf.has(key);
  }

  /**
   * Returns the representative key of the set containing `key`.
   *
   * @throws {RangeError} if `key` is unknown.
   */
  find(key: T): T {
    return this.#keys[this.#dsu.find(this.#index(key))]!;
  }

  /**
   * Returns `true` iff `a` and `b` are in the same set.
   *
   * @throws {RangeError} if `a` or `b` is unknown.
   */
  connected(a: T, b: T): boolean {
    return this.#dsu.connected(this.#index(a), this.#index(b));
  }

  /**
   * Returns the size of the set containing `key`.
   *
   * @throws {RangeError} if `key` is unknown.
   */
  size(key: T): number {
    return this.#dsu.size(this.#index(key));
  }

  /**
   * Merges the sets containing `a` and `b`.
   *
   * @returns `true` if two different sets were merged, `false` otherwise.
   * @throws {RangeError} if `a` or `b` is unknown.
   */
  union(a: T, b: T): boolean {
    return this.#dsu.union(this.#index(a), this.#index(b));
  }

  /** Resets back to one singleton set per key. The set of keys is unchanged. */
  clear(): void {
    this.#dsu.clear();
  }

  /**
   * Height of the tallest tree. Diagnostic method for testing and debugging:
   * O(n), does not modify state. See {@link DSU.maxDepth}.
   */
  maxDepth(): number {
    return this.#dsu.maxDepth();
  }

  #index(key: T): number {
    const index = this.#indexOf.get(key);
    if (index === undefined) throw new RangeError(`Unknown key: ${String(key)}`);
    return index;
  }
}
