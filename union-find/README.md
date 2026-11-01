# union-find

A disjoint-set union (union-find) structure in TypeScript, using **union by size** and **full path compression**.
It is a port of my competitive-programming C++ DSU and keeps the same algorithm.

It has no runtime dependencies, needs Node 20+, and is an ESM package.

## Install, build, run

```bash
npm install      # dev dependencies only
npm run build    # compile src/ to dist/
npm run example  # run examples/usage.ts with tsx
npm run check    # typecheck + build + tests with enforced 100% coverage
```

Dev dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `fast-check`, `tsx`.

## Layout

| Path | Purpose |
|---|---|
| `src/dsu.ts` | The core `DSU` over integers `0 .. n-1`, stored in `Int32Array`s |
| `src/generic-dsu.ts` | `GenericDSU<T>`: maps arbitrary keys to indices and delegates to `DSU` |
| `src/index.ts` | Re-exports both classes |
| `test/helpers.ts` | Seeded PRNG, independent references (BFS over an adjacency list, CSR-BFS component labelling), binomial-tree builder, fast-check settings |
| `test/unit/dsu.test.ts` | `DSU` unit tests: constructor, element validation, find, union, connected/size/count, clear, maxDepth, public entry point |
| `test/unit/generic-dsu.test.ts` | `GenericDSU` unit tests: construction, key types (string, number, object, NaN, ±0), API, unknown keys |
| `test/stress/height.test.ts` | Height bounds: the worst-case k = 20 binomial tree, `find` on its deepest leaf, random unions, chains |
| `test/stress/property.test.ts` | fast-check properties: `DSU` vs the BFS reference, invariants after every op, `GenericDSU` vs `DSU` and BFS |
| `test/stress/scale.test.ts` | 10⁶ elements: forward and backward chains, and a random workload checked against CSR-BFS |
| `vitest.config.ts` | Test discovery and the coverage thresholds (100% on `src/`) |

## API

### `DSU`

| Member | Description |
|---|---|
| `new DSU(n)` | Creates `n` singleton sets `{0} … {n-1}`. Throws `RangeError` unless `n` is an integer in `[0, DSU.MAX_ELEMENTS]` (2³¹−1). |
| `find(x): number` | Returns the root (representative) of `x`'s set and compresses the path. |
| `union(a, b): boolean` | Merges the two sets. Returns `true` if a merge happened, `false` if they were already the same set, including `a === b`. |
| `connected(a, b): boolean` | Returns whether `a` and `b` are in the same set. |
| `size(x): number` | Returns the size of `x`'s set. |
| `count: number` | The number of disjoint sets (read-only). |
| `clear(): void` | Resets to `n` singletons, keeping the same `n`. |
| `maxDepth(): number` | **Diagnostic.** Returns the height of the tallest tree (0 if all sets are singletons). It walks the parent array without path compression and does not modify state. Meant for testing and debugging. |
| `n: number` | The number of elements (read-only). |

Every method that takes an element throws a `RangeError` if the element is not an integer in `[0, n)`.

### `GenericDSU<T>`

| Member | Description |
|---|---|
| `new GenericDSU(keys: Iterable<T>)` | Creates one singleton per key. Throws `RangeError` on a duplicate key. |
| `find(key): T` | Returns a representative **key** (not an index). |
| `union(a, b)`, `connected(a, b)`, `size(key)`, `count` | Same as `DSU`. |
| `has(key): boolean` | Returns whether `key` is in the universe. |
| `clear(): void` | Resets to one singleton per key. The keys stay the same. |
| `maxDepth(): number` | **Diagnostic.** Delegates to `DSU.maxDepth()`. |

Any method given an unknown key throws a `RangeError` and changes nothing.

### Example

The examples import from `src/index.js`. tsx (used by `npm run example` and by the tests) resolves the `.js` specifier to `src/index.ts`:

```ts
// examples/usage.ts, run with: npm run example
import { DSU, GenericDSU } from "../src/index.js";

const dsu = new DSU(6);
dsu.union(0, 1);
dsu.union(1, 2);
dsu.union(3, 4);
dsu.connected(0, 2); // true
dsu.connected(0, 3); // false
dsu.size(2);         // 3
dsu.count;           // 3: {0,1,2} {3,4} {5}
dsu.union(2, 0);     // false: already in the same set
dsu.maxDepth();      // 1
dsu.clear();         // back to 6 singletons

const friends = new GenericDSU(["alice", "bob", "carol"]);
friends.union("alice", "bob");
friends.connected("alice", "bob"); // true
friends.count;                     // 2
```

Plain `node` can't run `.ts` files. Run `npm run build` first, then import the compiled JavaScript from `dist/`:

```js
// demo.mjs, at the project root: node demo.mjs
import { DSU } from "./dist/index.js";

const dsu = new DSU(3);
dsu.union(0, 2);
console.log(dsu.connected(0, 2), dsu.count); // true 2
```

## How it works

Each set is a tree stored in a parent array. An element is a root exactly when `parent[x] === x`, and the root is the set's representative. `setSize[r]` holds the size of the set whose root is `r`. That value is only kept up to date at roots.

- **`find` with full path compression.** `find` follows parent links up to the root. As the recursion unwinds, it sets `parent` of every node on the path to the root.
- **`union` by size.** `union` finds both roots and attaches the root of the **smaller** set under the root of the **larger** set, then adds the sizes. On a tie, the first argument's root stays the root. Merging two different sets is the only thing that decrements `count`.

**What each heuristic gives on its own, and together:**

- **Union by size alone** gives O(log n) **worst case** per operation. An element's depth grows by one only when its root is attached under another root. That happens only when its set is the smaller one, so the merged set is at least twice as large. A set can double at most log₂ n times, so every tree has height ≤ ⌊log₂ n⌋.
- **Path compression alone** gives O(log n) **amortized** per operation. A single `find` can still cost O(n), because without a union heuristic, unions can build a chain of length n before it is ever compressed.
- **Both together** give O(α(n)) **amortized** per operation. Tarjan (1975) proved that any m operations on n elements take O(m · α(n)) time. The worst case for a single operation is still O(log n), because of the height bound above.

**What α(n) is.** α is the inverse Ackermann function. It grows so slowly that α(n) ≤ 4 for any n that could ever be stored, so in practice each operation takes constant time.

### Complexity per method

`n` is the number of elements. "Space" means extra memory used during the call, not counting the structure itself.

| Method | Time | Extra space |
|---|---|---|
| `new DSU(n)` | O(n) | O(n) (the structure: 8 bytes per element) |
| `find(x)` | O(α(n)) amortized, O(log n) worst case | O(log n) stack (recursion depth ≤ tree height) |
| `union(a, b)` | O(α(n)) amortized, O(log n) worst case | O(log n) stack |
| `connected(a, b)` | O(α(n)) amortized, O(log n) worst case | O(log n) stack |
| `size(x)` | O(α(n)) amortized, O(log n) worst case | O(log n) stack |
| `count` | O(1) | O(1) |
| `clear()` | O(n) | O(1) |
| `maxDepth()` | O(n) (each node's depth is computed once and memoized) | O(n) extra space (a temporary `Int32Array` memoization buffer of depths) |

For `GenericDSU`, the constructor is O(k) for k keys, with an O(k) `Map` plus a key array. Each method adds one expected-O(1) `Map` lookup per key on top of the `DSU` cost.

**Total space.** The structure is O(n): two `Int32Array`s, which is 8 bytes per element, or about 8 MB per 10⁶ elements.

## Assumptions

- **Element domain.** `DSU` works on the integers `0 .. n-1`, 0-indexed, with `n` fixed at construction. `n = 0` is allowed and gives an empty structure.
- **Limits.** The constructor rejects `n > 2³¹−1` (`DSU.MAX_ELEMENTS`), because indices and sizes are stored as int32. **In practice the limit is memory.** At 8 bytes per element (about 8 MB per 10⁶ elements), a very large `n` fails when the arrays are allocated, long before it reaches the int32 limit. For example, n = 2³¹−1 would need about 16 GB.
- **Unknown or invalid elements.** Out-of-range values, non-integers, `NaN`, `±Infinity`, and non-numbers passed from untyped JavaScript (`"1"`, `null`, `undefined`) all throw a `RangeError` with a clear message. Both arguments are checked before any work is done, so **state is unchanged after a throw**, and no path compression happens either. There is no automatic growth. `GenericDSU` also throws a `RangeError` for a key that wasn't passed to its constructor, and for duplicate keys at construction.
- **Self-union is a no-op.** `union(x, x)` returns `false` and changes nothing.
- **`union` return value.** It returns `true` if and only if two different sets were merged, which is exactly when `count` drops by one. Repeating a union returns `false`.
- **Representative choice.** Which element ends up as the root is an implementation detail, apart from the documented tie-break (the first argument's root wins). Callers should compare representatives, not depend on which one is chosen.
- **Recursive vs iterative `find`.** `find` is **recursive**, as in my original. That's safe because union by size limits the recursion depth to the tree height, which is ⌊log₂ n⌋ ≤ 30 for any allowed `n`. The test suite builds the worst-case binomial tree of height 20 on 2²⁰ elements and runs `find` on its deepest leaf. An iterative two-pass version would leave exactly the same `parent` array. It would only matter if the union heuristic were removed.
- **Keys in `GenericDSU`** are compared like `Map` keys (SameValueZero): primitives by value, objects by identity. `NaN` is a valid key, and `0` and `-0` are the same key.
- **Index validation and `!` non-null assertions.** Every public method validates indices up front (`#check(x)`). Stored parent pointers are initialized to identity and only ever point to valid roots within `[0, n)`. Because `tsconfig.json` enables `noUncheckedIndexedAccess`, typed array index lookups type as `number | undefined`. Non-null assertions (`!`) are used internally because indices are mathematically proven in-bounds. Replacing them with fallback values or defensive branches would add unreachable code, penalize performance on hot paths, and skew 100% branch coverage.
- **Not thread-safe.** Even read-only `find` writes to the arrays, because of path compression. This is irrelevant on JS's single thread, but it would matter if the arrays were shared through a `SharedArrayBuffer`.

## Running the tests

| Script | What it does | When to use it |
|---|---|---|
| `npm test` | Runs every test once | Default check before committing |
| `npm run test:watch` | Re-runs affected tests on file changes | While developing |
| `npm run test:coverage` | Runs every test with v8 coverage. **Fails** if line, branch, function, or statement coverage of `src/` drops below 100% | Before pushing, and in CI |
| `npm run test:unit` | Only `test/unit/` (fast, under 1 s) | Quick feedback on API behaviour |
| `npm run test:stress` | Only `test/stress/`: height bounds, fast-check properties, 10⁶-element scale tests (about 10 s) | After touching the algorithm or for performance work |
| `npm run typecheck` | `tsc --noEmit` in strict mode, over `src`, `test`, and `examples` | Type errors only |
| `npm run build` | Compiles `src/` to `dist/` with `.d.ts` files | Before using the package from plain `node` |
| `npm run example` | Runs `examples/usage.ts` with tsx | Quick demo |
| `npm run check` | `typecheck` + `build` + `test:coverage` | One command that must pass before handing in |

**A single file:**

```bash
npx vitest run test/unit/dsu.test.ts
```

**A single test, or a group, by name** (`-t` matches a substring or regex of the full test name):

```bash
npx vitest run -t "tie-break"
npx vitest run test/unit -t "element validation"
```

**Coverage report.** `npm run test:coverage` prints a summary in the terminal and writes an HTML report to `coverage/index.html`. Open it with `xdg-open coverage/index.html` on Linux or `open coverage/index.html` on macOS. `coverage/coverage-summary.json` has the same numbers in machine-readable form. The thresholds are set in `vitest.config.ts`.

**Reproducing a failing property test.** Property tests use a fixed seed (`20261031`), so every run is deterministic. When a property test fails, fast-check prints the counterexample along with the exact `seed` and `path` to replay it, for example `{ seed: 20261031, path: "47:3:0" }`. Copy that `path` value and run the command combined with `-t "<test name>"` to target only the failing test (because `FC_PATH` is specific to the generator tree of that individual test):

```bash
# Copy the exact path from fast-check output and target the failing test with -t:
FC_SEED=20261031 FC_PATH="47:3:0" npx vitest run test/stress/property.test.ts -t "matches a naive BFS reference"
```

`FC_SEED` alone (for example `FC_SEED=1`) explores a different random sample without setting a path. `FC_RUNS=5000` raises the number of generated cases. These variables are read in `test/helpers.ts` (`propertyParams`).

**How expected values are chosen.** No test compares the code's output against itself. Expected values are either derived by hand (with the derivation noted in a comment, for example tree shapes and tie-breaks), known invariants (root sizes sum to n, height ≤ ⌊log₂ n⌋), or come from an independent reference implementation in `test/helpers.ts`. `GenericDSU` is checked against both `DSU` and the BFS reference.

## Changes from the original C++

| Change | Why |
|---|---|
| **Added bounds and integer checks** (`RangeError`) on `n` and on every element | In C++, `vector::operator[]` out of range is undefined behaviour. In JS, a typed array returns `undefined` for such reads and silently drops the writes, so bad input would quietly corrupt results. This is a correctness and safety fix. |
| Checks happen once in each public method, which then calls a private recursive `#findRoot` | So the check doesn't run at every level of the recursion. The algorithm is unchanged. |
| **Removed `sizeU(u)`** from the public API | It returns `sz[u]` without calling `find`, so for any element that isn't a root it returns an old, wrong value. That's fine inside contest code but a trap in a public API. `size(x)` is the correct public way to get a set's size. |
| **Added `count`** (number of disjoint sets) | It was required by the API spec. It is decremented only on a successful merge, and `clear()` resets it. |
| **Added `maxDepth()`** (diagnostic) | It lets tests and debugging check that the heuristics keep trees short (height ≤ ⌊log₂ n⌋) without exposing the internal arrays. It doesn't compress paths, so measuring doesn't change what is measured. |
| Renamed `inOneSet` → `connected`, `unit` → `union`, `par` → `parent`, `sz` → `setSize`, `N` → `n` | Clearer, conventional names. Semantics and return values are unchanged. |
| `vector<int>` → private `Int32Array` fields (`#parent`, `#setSize`), allocated once in the constructor | Fixed-size, contiguous typed storage. All internal state uses `#` private fields. `clear()` reuses the same arrays, just like `assign` and `iota`. |
| Added `GenericDSU<T>` in a separate file | It was an optional requirement. It wraps the core without modifying it. |

What I kept the same: union by **size** (not rank), recursive **full** path compression (not halving or splitting), the comparison `size[A] < size[B] → swap`, so ties keep the first argument's root, and `union` returning `false` when both elements already share a root.
