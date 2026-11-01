# fs-snapshot-diff

Take a compact snapshot of a directory tree, save it as JSON, and later compute
what changed between two snapshots: additions, removals, content changes,
permission changes, type changes and moves/renames.

```
$ fsdiff snapshot ./project -o monday.json --ignore node_modules,.git
$ # ... time passes, files change ...
$ fsdiff snapshot ./project -o friday.json --ignore node_modules,.git
$ fsdiff diff monday.json friday.json
~ README.md  content changed (3 B -> 11 B)
> docs/old.md -> docs/new.md
~ run.sh  mode 0644 -> 0755
> src/lib/ -> src/core/
+ tmp/
+ tmp/x

6 change(s): 2 added, 0 removed, 1 modified, 1 metadata changed, 0 type changed, 2 moved.
Visited 15 node(s), skipped 0 identical subtree(s).
```

## Install, run, test

Requires Node 20+. Runtime code uses only Node built-ins; `typescript`, `vitest`,
`@vitest/coverage-v8`, `fast-check`, `tsx` and `@types/node` are dev dependencies.

```sh
npm install
npm test               # all tests (see "Running the tests")
npm run typecheck      # tsc --strict over src and test
npm run build          # compiles to dist/
npm run check          # typecheck + build + tests with 100% coverage enforced

# Run the CLI without building (`npm run cli -- <command> ...` also works):
npm run snapshot -- <dir> -o snap.json [--ignore node_modules,.git] [--fast] [--pretty]
npm run diff -- before.json after.json [--json] [--mtime] [--no-moves]

# Or after building:
node dist/cli.js diff before.json after.json
```

`diff` exits with 0 when there are no differences, 1 when there are, and 2 on
error (like `diff(1)`), so it can be used in scripts. `fsdiff --help` prints
the usage to stdout and exits with 0; `fsdiff` with no command prints it to
stderr and exits with 2. An empty string as the directory, the `-o` file or a
snapshot file is a usage error (exit 2): `path.resolve("")` would silently mean
the current directory, and an empty `-o` would mean stdout.

When output can't be written:

- `fsdiff diff` whose reader closes stdout early (`fsdiff diff a b | head`)
  stops writing quietly, with no stack trace, and still exits with its own 0
  or 1: the exit code, not the text, says whether anything changed. Any other
  stdout failure (e.g. `ENOSPC`) is an error, exit 2.
- `fsdiff snapshot` without `-o` exits with 2 if the snapshot can't be fully
  written to stdout, including when the reader stops early (`| head -c 10`):
  a partial snapshot is useless. It prints `error: could not write the whole
  snapshot to stdout (write EPIPE)` to stderr, if stderr is still writable.
- A closed stderr (`fsdiff … 2>&1 | head`) stops further warnings quietly and
  never changes the exit code; there is nowhere left to report it.

## Running the tests

| Command | What it runs |
| --- | --- |
| `npm test` | every test once |
| `npm run test:unit` | `test/unit/`: in-memory trees built with `fromObject`, no disk access |
| `npm run test:integration` | `test/integration/`: real temp folders under `os.tmpdir()` (always removed afterwards), mocked races, and the CLI in-process and as a real subprocess |
| `npm run test:watch` | vitest in watch mode |
| `npm run test:coverage` | every test, with v8 coverage of `src/` |
| `npm run check` | `typecheck`, `build`, then `test:coverage`; what to run before a commit |

There are 338 tests: 272 unit tests in 7 files and 66 integration tests in 3
files. On Linux as a non-root user all of them run; elsewhere some skip (see
below).

- **One file:** `npx vitest run test/unit/diff.test.ts`.
- **One test by name** (a substring or regex of its full name):
  `npx vitest run -t "folder rename"`, which can be combined with a file.
- **Coverage:** `npm run test:coverage` prints a summary and writes an HTML
  report to `coverage/index.html`. Thresholds are 100% for statements,
  branches, functions and lines over `src/**`, and the run fails below that.
  Only `src/cli.ts` is excluded: it is the thin bin entry that wires `run()`
  to the real process, and it is tested by subprocess tests that v8 coverage
  can't see.
- **Property tests** (`test/unit/diff.property.test.ts`) generate random trees
  and random mutations with fast-check and compare `diff` against a naive
  reference diff (flatten both trees to path maps; no pruning, no moves). They
  check that:
  - with moves off, the result matches the reference, with and without pruning;
  - with moves on, expanding every move back into its removed and added paths
    gives the reference again, moves are 1-to-1, and each move's two subtrees
    are identical;
  - content that appears more than once among the unmatched paths on either
    side is never moved: those paths stay `removed` / `added`;
  - a tree compared with itself reports nothing and is pruned at the root.

  The seed is fixed (`20261101`, 300 runs), so a run is
  reproducible. On a failure fast-check prints a `seed` and a `path`; replay
  exactly that case with
  `FC_SEED=<seed> FC_PATH="<path>" npx vitest run test/unit/diff.property.test.ts -t "<test name>"`.
  `FC_RUNS=<n>` runs more cases, and a different `FC_SEED` explores new ones.
- **Skipped tests.** Tests that need names or symlink targets that are not
  valid UTF-8 run only on Linux, and also skip on Linux file systems that
  reject such names; these print the reason as a skip note. Permission tests
  skip when running as root (root can read anything), and FIFO and
  shell-pipe tests skip on Windows.

## Layout

| File               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `src/model.ts`     | Node types, Merkle hashing, name ordering                                |
| `src/snapshot.ts`  | `buildSnapshot` (real disk), `fromObject` (in memory), `serialize`/`deserialize` |
| `src/ignore.ts`    | Small glob matcher for `--ignore`                                        |
| `src/diff.ts`      | `diff(before, after)`                                                    |
| `src/report.ts`    | Human-readable report                                                    |
| `src/cli/run.ts`   | `run(argv, io)`: argument parsing and the two commands; returns the exit code, writes only through `io`, and never throws unless `io` itself throws |
| `src/cli.ts`       | The `fsdiff` bin entry: calls `run` with the real argv, stdout and stderr; passes stdout write failures to `run` and stops writing to a closed stderr |
| `src/quote.ts`     | `formatPath` / `formatMessage` / `escapeJsonForTerminal`: safe display of names, targets, messages and JSON |
| `test/unit/`       | Tests on in-memory trees, including the property tests                   |
| `test/integration/`| Tests on real temp folders, mocked file system races, and the CLI        |

## Data model

```ts
type FsNode = FileNode | DirectoryNode | SymlinkNode;

FileNode      { type: "file",      name, size, mtimeMs, mode, contentHash }
DirectoryNode { type: "directory", name, mode, children: FsNode[] /* sorted */, hash }
SymlinkNode   { type: "symlink",   name, target, targetEscaped?: true }

Snapshot { version, rootPath, createdAt, options: { ignore, fast }, root: DirectoryNode, errors }
```

- **Files** keep metadata plus the SHA-256 of their contents, never the contents.
  `mode` keeps only the permission bits (`st_mode & 0o7777`); the file type is in `type`.
- **Directories** keep their children sorted by name (UTF-16 code-unit order,
  locale independent) and a **Merkle hash**: SHA-256 of the JSON list
  `[[name, type, mode, hash], ...]` over the sorted children, where `hash` is the
  child's content hash, Merkle hash, or symlink target (an escaped target
  gets a NUL prefix here, see below). So:
  - two directories with the same hash have identical subtrees (names, types,
    permissions, contents), which is what lets the diff skip them;
  - the directory's **own name is not in its hash**, so a renamed folder keeps its
    hash and can be detected as a move;
  - `mode` is in the hash so a `chmod` deep in the tree is not hidden by pruning;
    `mtime` is deliberately left out (see "Definition of difference").
  - Sorting before hashing makes the hash independent of `readdir` order.
- **Symlinks** store the `readlink` target and are never followed. The target
  is read as raw bytes and decoded as strict UTF-8. If it is not valid UTF-8
  (possible on Linux), it is stored in the same escape format as invalid file
  names (`a` + byte `0xFF` is `a\xFF`, see "Assumptions") and the node gets
  `targetEscaped: true`, so a change from one invalid target to another is
  still detected. The escaped form never equals a real target that literally
  reads `a\xFF`: for the Merkle hash, the diff and move matching an escaped
  target is keyed as NUL + `escaped:` + text, and no real target can contain
  NUL. The report shows its bytes as escapes inside quotes and labels it
  outside them: `~ l  link target "a\xFF" (escaped: not valid UTF-8) ->
  "a\\xFF"` (the second target is real text with a backslash).
- **Paths are not stored.** A node stores only its own name; full paths are
  rebuilt while walking. This avoids repeating long prefixes in every entry.
- `errors` lists paths below the root that were left out of the tree, instead
  of failing the whole scan. Each entry is `{ path, kind, code?, message }`,
  and `kind` is decided when the error is recorded:
  - `unreadable`: the entry was listed but could not be read: `EACCES`,
    `EPERM`, `EIO`, `EBUSY`, `ELOOP`, `ENAMETOOLONG`, `EMFILE`, a read failure
    after a successful `lstat`, or any other unexpected error;
  - `unsupported`: a socket, FIFO or device file (never opened);
  - `invalidName`: a name that is not valid UTF-8 (see "Assumptions").

  Entries deleted mid-scan are not errors; they are simply absent (see
  "Scanning is not atomic"). The root itself must be readable: a missing root
  (`ENOENT: no such file or directory, stat '<root>'`), a root that is a file
  (`not a directory: <root>`), an unlistable root (`EACCES`), or a root deleted
  between that check and its `readdir` (`ENOENT ... scandir '<root>'`) makes
  `buildSnapshot` throw, because an empty snapshot would only produce a
  misleading diff later.
- The root directory's own `mode` is stored on `root.mode`. It's in no hash
  (the root has no parent entry), so the diff compares it explicitly.

**Why it's compact:** the size of a snapshot depends on the *number* of entries,
not on the size of the files: about 170 bytes of JSON per entry (measured on this
repo's `node_modules`: name, three numbers, a 64-character hash), whatever the file size. A 10 GB video costs the same as an empty
file. All the information needed to compare later is a fixed-size fingerprint.

`fromObject({ "a.txt": "hello", src: { "x.ts": file("...", { mode: 0o755 }) } })`
builds the same structure in memory, so the diff tests never touch the disk.
A string is a file, a plain object is a directory, and `file()`, `symlink()`
and `directory(children, { mode })` give more control (`symlink()` also takes
raw bytes, escaped like a real scan would); `{ rootMode }` sets the
root's mode. Any other value (e.g. `null`) throws a `TypeError` naming the entry.
Every node it builds goes through the same rules as `deserialize` (one shared
function, `nodeProblem`, listed below), so a tree that no real scan could
produce, such as a name `..` or a mode above `0o7777`, also throws a `TypeError`.

`serialize` / `deserialize` convert to and from JSON. The round-trip is lossless
(tested with `toEqual`). The format has a `version`, currently 1, to be
bumped whenever the serialized shape changes; any other version is rejected
with `unsupported snapshot version: … (this version of fsdiff reads version 1;
take the snapshot again)`. `deserialize` validates the shape of every node and every
`errors` entry and **recomputes every directory hash**, so a corrupt or
hand-edited snapshot is rejected instead of producing a wrong diff or a crash.

**A snapshot file is untrusted input.** Recomputing hashes only proves the file
is self-consistent; whoever edits it can recompute them too. So `deserialize`
also checks these values against what a real scan could produce:

- entry names at every depth: not empty, `.` or `..`, no `/` or NUL byte;
- `size`: a non-negative safe integer; `mode` (files, directories and the
  root): an integer from 0 to `0o7777`; `mtimeMs`: finite (fractional and
  pre-1970 values are real, so they are accepted);
- `errors[]`: `path` is relative and every `/`-separated segment follows the
  same name rules; for `invalidName` the last segment must be exactly in the
  escape format below; `kind` is one of the three kinds; `message` is a string
  and `code`, if present, a string;
- symlink `target`: non-empty with no NUL byte; `targetEscaped`, if present,
  must be `true` and the target must be exactly in the escape format for bytes
  that are not valid UTF-8;
- `options.ignore` items are strings;
- the `version` is checked first, so a file from another version always gets
  the "unsupported snapshot version … take the snapshot again" message, even
  if that version has fields this one doesn't know;
- no unknown fields, on the snapshot, `options`, `errors[]` entries, or any
  node (e.g. `children` on a file, `targetEscaped` on a directory). The error
  names the field: `invalid snapshot: root/.[1] has unknown field "children"`.

The node rules (names, sizes, modes, mtimes, targets, `targetEscaped`) are
one function shared with `fromObject`, so the two can't drift apart.

Without the name and path checks, a tampered snapshot could make the diff
print paths such as `../../etc/passwd` or `a/../../x`, and any script that
acts on the diff output (deletes "removed" paths, copies "added" ones) would
be led outside the tree. Rejecting the snapshot as a whole is safer than
escaping or skipping the bad names. This is validation, not authentication:
see "Known limitations".

### Ignore patterns

A small subset of `.gitignore` (no negation, so order never matters):

| Pattern          | Matches                                                       |
| ---------------- | ------------------------------------------------------------- |
| `node_modules`   | an entry with that name at any depth                          |
| `*.log`          | names by glob: `*` and `?` never cross `/`, `**` does          |
| `build/cache`    | a `/` at the start or in the middle anchors it to the root path |
| `/dist`          | `dist` at the root only                                       |
| `build/`         | a trailing `/` means directories only: the `build` folder at any depth, not a file named `build` |

`/` is the only separator; `\` is an ordinary character because it is legal
in POSIX file names (git also requires `/` on Windows). Ignored directories are
not descended into.

## Definition of "difference"

`diff(before, after)` compares paths relative to the two roots. Each path that
changed falls in exactly one category:

| Category          | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `added`           | The path exists only in `after`.                                                              |
| `removed`         | The path exists only in `before`.                                                             |
| `modified`        | Same path, both files, different `contentHash`. Also: same path, both symlinks, different target. |
| `metadataChanged` | Same path, same type, same content, but `mode` differs (or `mtime`, if `compareMtime: true`). Applies to files and directories, including the root itself, reported as path `.`. |
| `typeChanged`     | Same path, different node type (file to directory, symlink to file, ...).                     |
| `moved`           | A removed path whose content matches **exactly one** added path, reported once as `from -> to` instead of an add plus a remove. If the moved node's own metadata also changed (e.g. renamed and `chmod`ed), the entry's `changes` lists it. |

Details and reasons:

- **Added/removed are listed for every path**, including everything inside a new
  or deleted folder (`+ tmp/` and `+ tmp/x`). That matches the definition
  literally ("path exists only in after"), makes the summary counts meaningful,
  and lets a single file moved into a new folder still be detected as a move.
  The cost is a long list when a large folder appears, which is what `--ignore` is for.
- **A content change wins over a mode change.** If both changed, the file is
  `modified` (the entry carries the before/after nodes, so the mode is still
  visible). `metadataChanged` means "only metadata changed". Likewise a move
  wins over a mode change; the move entry carries the change
  (`> old.txt -> new.txt  mode 0644 -> 0755`).
- **mtime is ignored by default.** It changes on `touch`, on copies, on
  checkouts, even when nothing really changed; content is what matters.
  `compareMtime: true` (CLI `--mtime`) reports it, and turns off pruning
  because mtime is not part of the Merkle hash.
- **Type change** reports the path once. If a folder was replaced by a file,
  the folder's old contents are `removed` (they really are gone), and vice versa.
- **Moves** are exact-hash and 1-to-1. Candidates are tried **largest subtree
  first** (directories before files, bigger directories before smaller ones,
  ties by path). A renamed folder becomes a single `moved` entry, and its
  contents are taken out of the candidate lists so they're not listed again.

  A pair is made only if the hash occurs exactly once among the removed
  candidates and exactly once among the added candidates that are *still
  unmatched*. So if `a/sub` and `other` are identical, and `a` moves to `b`
  (taking `a/sub` along), `other` can still be matched to its new name. If the
  same content is still there more than once on either side, the algorithm
  doesn't guess: they stay as adds and removes. Trying larger subtrees first
  makes the result independent of names: a candidate can only lose a twin when
  a larger ancestor moves, and all of those were tried before it. **Empty files and empty directories are never matched**:
  they all share the same hash, so a pairing would be arbitrary. A copy (the
  original is still there) is an `added`, not a move. A move whose content also
  changed is not detected (it's an add plus a remove). That's the cost of exact
  matching, see limitations.
- **Paths with unknown state are not reported.** If a path is present on one
  side but was recorded as `unreadable` or `invalidName` on the other, it
  exists but we don't know what it holds, so it and its subtree are left out
  (counted in `stats.skippedUnreadable`) and a warning is added. It is never
  reported as added or removed, nor used as either end of a move. This is
  checked at every depth of an added or removed subtree, not only at its top.
  So a file that fails with `EIO` in the after scan is not `removed`, and if
  an identical copy appeared elsewhere it is `added`, not a move.
- **Unsupported file types count as absent.** Sockets, FIFOs and devices are
  not tracked, so an `unsupported` error does not hide a change: a FIFO
  replaced by a regular file is `added`, and the reverse is `removed`. These
  errors produce a separate warning.
- Diffing a **fast-mode snapshot against a full-hash one throws**: their file
  hashes mean different things. Different ignore lists (compared as sets, so
order doesn't matter) produce a warning.
- Output: each list is sorted by path (`moved` by `from`), plus `summary`
  (counts per category and total), `stats` (visited nodes, pruned subtrees, skipped unknown paths) and `warnings`.
- **Report** (`formatReport`, the CLI's default output): one line per change,
  sorted by path; `+` added, `-` removed, `~` modified, metadata or type
  change, `>` moved. A directory gets a trailing `/` on every kind of line. A
  type-change line shows the path as it is in `after`: `~ x/  type file ->
  directory` (now a folder), `~ x  type directory -> file` (now a file).
- **Quoting.** Anyone who can create a file in the scanned tree chooses its
  name, and a name can hold any character except `/` and NUL. Printed raw, a
  crafted name could forge report lines (`\n`), overwrite one (`\r`), erase a
  real change from the screen (`ESC[1A ESC[2K`), recolour text, set the
  terminal title, or reorder a line visually (bidi overrides). So every path,
  move end and symlink target in the report, and every path or argument the
  CLI puts in its own warnings and messages, goes through one function,
  `formatPath`, which follows Git's `core.quotePath` approach:
  - a string of only safe printable characters is printed as is;
  - anything else is printed inside double quotes with C-style escapes: `\n`,
    `\r`, `\t`, `\"`, `\\`; other control characters (U+0000-U+001F, U+007F,
    U+0080-U+009F) as `\xNN`; other unsafe Unicode (format characters such as
    bidi overrides U+202E and zero-width characters, U+2028/U+2029, lone
    surrogates) as `\u{...}`. Every `\xNN` stands for one byte, so a C1
    control such as U+0085 prints as its two UTF-8 bytes, `\xC2\x85`;
  - an empty string prints as `""`, and any string containing `"` or `\` is
    quoted, so an unquoted name never starts with `"`;
  - so is any string containing `->`, two spaces in a row, or a leading or
    trailing space. The report uses ` -> ` and two spaces as separators, so
    otherwise two different changes could print the same line (a move of
    `a -> b` to `c`, and of `a` to `b -> c`, would both be `> a -> b -> c`), and
    an edge space would be invisible. Ordinary names with single spaces stay
    unquoted;
  - a name stored in escaped form (not valid UTF-8) prints its bytes as `\xNN`
    inside quotes, while a real backslash prints as `\\`: the bytes
    `a`+`0xFF` show as `"a\xFF"`, a name that really reads `a\xFF` as
    `"a\\xFF"`;
  - labels such as `(escaped: not valid UTF-8)` and a directory's trailing
    `/` go outside the quotes, where no name can reach.

  Free-text messages that may contain names (Node error messages, diff
  warnings) go through `formatMessage`, which applies the same escapes for
  control and unsafe characters but adds no quotes, so ordinary messages read
  normally. Either way the output never contains a control character except
  the CLI's own line breaks.

  JSON output (`fsdiff diff --json`, and snapshots, which `fsdiff snapshot`
  prints to stdout without `-o`) is exact and terminal-safe too.
  `JSON.stringify` escapes C0 controls but writes DEL, C1 controls, bidi
  overrides and isolates, zero-width characters and U+2028/U+2029 raw, so
  those are rewritten as `\uXXXX` escapes afterwards. They can only occur
  inside JSON strings, where the escape means the same character, so the JSON
  parses back to exactly the same data.

  Look-alike characters are printed as they are, the same choice Git makes:
  homoglyphs (Cyrillic `а` vs Latin `a`), a no-break space, or a character that
  renders blank such as U+3164 can make two different names look alike, but
  escaping them would make legitimate non-Latin names unreadable. Only
  characters that control the terminal or reorder or hide text are escaped.
  Use `--json` when the exact bytes matter.

## Algorithm

**Build:** recursive walk with `lstat` (never `stat`, so symlinks aren't
followed). Files are hashed with `fs.createReadStream` into a SHA-256, so memory
use per file is one chunk (64 KiB) regardless of size. Concurrency (default
32, must be a positive integer) is bounded in two ways:

- a shared limiter caps file system operations in flight, so large trees
  don't hit `EMFILE`; its queue is a FIFO with a read index, O(1) per task;
- inside each directory at most `concurrency` entries are in progress at once
  (`mapWithConcurrency`), instead of `Promise.all` over every entry, which
  for a 200k-entry directory would mean 200k pending promises.

Measured with empty files (Node 22, Linux, 8 cores, under moderate load):
one flat directory of 200,000 files takes about 42 s with a 136 MB peak heap;
200 directories × 500 files about 22 s with 89 MB. The finished snapshots
retain 42 MB and 21 MB. Times depend heavily on the machine and on the file
system cache. Each directory is sorted and hashed when its children are done
(bottom-up).

**Diff:** walk both trees together from the root.

1. For each pair of directories at the same path: if their Merkle hashes are
   equal, **skip the whole subtree** (`stats.prunedSubtrees++`). Otherwise
   **merge** the two sorted child lists in one linear pass, like the merge step
   of merge sort: a name only on the left is removed, only on the right is
   added, on both sides is compared and recursed into.
2. One-sided subtrees are collected (path to node) in pre-order.
3. Move detection indexes those candidates by `type:hash` (each key maps to
   its candidates' paths and nodes), sorts them by subtree size, and pairs up
   the unique ones; a move removes its whole subtree from the maps and the
   index.

The root's own mode is compared before step 1, because it's in no hash.

`stats.visitedNodes` counts every node the diff touches. A test builds a tree
of 6,825 nodes, changes one file six levels down, and checks that exactly
`1 + depth * 2 * fanout + fanout` = 45 nodes are visited (every child of each
directory on the changed path, nothing else), versus all 6,825 when pruning is off.

## Complexity

Let N = number of entries, B = total bytes of file contents, k = entries in one
directory, d = depth.

| Operation                | Time                                                       | Space                                  |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------- |
| `buildSnapshot`          | O(B) hashing + O(N log k) sorting (O(N) syscalls). Fast mode: no O(B) term | O(N) for the tree; O(64 KiB × concurrency) for hashing |
| `serialize`/`deserialize`| O(N) (deserialize re-hashes each directory's entry list)    | O(N)                                   |
| `diff`, worst case       | O(N_before + N_after) for the walk, plus O(C log C) to sort C changed paths | O(C)                                   |
| `diff`, one change       | O(d × k): only the directories on the changed path are opened | O(d) recursion                          |
| identical trees          | O(1): the root hashes are equal                            | O(1)                                   |

Move detection is O(C log C): the candidates are sorted by subtree size, then
each is looked up in hash maps (no nested loops). Subtree sizes are memoized,
and consuming a moved directory's subtree is O(size of that subtree), so
everything apart from the sort is linear.

## Assumptions

- **Symlinks are not followed**; only their target string is recorded. This avoids
  cycles and escaping the root. The root path itself is resolved with `stat`, so
  passing a symlink to a directory as the root works.
- **mtime is ignored by default**; content is compared by SHA-256.
- **Names are case-sensitive and compared byte for byte (UTF-16 code units).**
  `Readme.md` and `README.md` are different paths, and Unicode NFC/NFD forms
  of the same name (`café`) are different paths. On case-insensitive or
  normalizing file systems (default macOS APFS) a case-only rename shows as
  remove + add.
- **No hard-link detection**: two hard links to the same inode are two files
  with the same content hash (and therefore never matched as a move).
- **Scanning is not atomic.** A file that changes while being scanned can end
  up with a size and hash from different moments, and the tree is not one
  point-in-time view. A consistent view would need a file system snapshot
  (LVM/ZFS/btrfs/VSS) underneath. An entry deleted between being listed and
  being read (`ENOENT`, or `ENOTDIR` when its parent was replaced by a file) at
  any step, whether `lstat`, `readlink`, opening the file for hashing, or a
  subfolder's `readdir`, is left out without an error, as if the scan had
  started after the deletion, so the diff reports it as `removed`. Recording
  it as an error would make the diff treat it as unknown and hide a real
  deletion. If a folder is deleted after it was itself listed and read, its
  children vanish one by one and the folder stays in the snapshot, possibly
  empty. Any other failure (e.g. `EINVAL` from `readlink` when a symlink was
  replaced by a regular file in between) is recorded as `unreadable`.
- Sockets, FIFOs and device files are skipped (recorded in `errors` as `unsupported`); reading a FIFO would block.
- Owner/group, extended attributes, ACLs and access times are not recorded.
- Both snapshots are assumed to be of "the same" tree; `rootPath` is informational.
  Comparing two different roots (e.g. a backup against the original) works.
- **File names must be valid UTF-8 to be snapshotted.** Directories are read
  with raw byte names, and each name is decoded with a strict UTF-8 decoder.
  A name that fails to decode (possible on Linux, which allows any bytes) is
  never `lstat`ed: it is left out of the tree, and if it is a folder, so is its
  contents. It is recorded as an `invalidName` error whose path ends in an
  escaped form of the name: valid characters are kept, each byte that is not
  part of a valid character becomes `\xHH` (upper-case hex), and `\` becomes
  `\\`. So `a` + byte `0xFF` is `a\xFF`, and two different invalid names
  always get two different paths (e.g. `warning: could not read "sub/a\xFF":
  file name is not valid UTF-8; skipped`, quoted as described under
  "Quoting"). Ignore patterns are matched against this escaped name. In the diff it is treated like `unreadable`: an invalid
  name created between scans produces a warning, not an `added`. A valid name
  that really contains U+FFFD is an ordinary name: it is snapshotted next to an
  invalid twin that would have decoded to the same string, and if it is
  deleted mid-scan it is `removed` like any other entry. One corner case: an
  escaped path is a plain string, so a valid name that literally contains the
  same text (e.g. a file really named `a\xFF` with a backslash) next to an
  invalid `a`+`0xFF` would have its changes suppressed too.
- SHA-256 collisions are treated as impossible.

## Non-null assertions

TypeScript runs with `strict` and `noUncheckedIndexedAccess`, and `src/`
uses the non-null assertion `!` exactly once: `char.codePointAt(0)!` in
`escapeUnsafe` (`src/quote.ts`). `char` comes from `for (const char of text)`,
which yields one whole code point at a time, so it is never empty and
`codePointAt(0)` is always a number. Everywhere else lookups are written so the
compiler can see the value is defined (`for..of`, `charAt`, `Map` entries,
optional chaining), and `src/` has no type casts (its only `as` is one
`as const`). The use carries a comment pointing here. The tests use `!` three
times, all in the property tests' tree helpers, each with a comment giving the
reason.

## Known limitations and what I'd add with more time

- **Moves with edits** aren't detected. Next step: for unmatched removed/added
  files of similar size, compare chunk-level hashes (content-defined chunking,
  as in rsync/restic) and report a similarity score, like `git diff -M`.
- **Ambiguous moves** (duplicated content) are reported as adds/removes. A
  tie-breaker (same base name, nearest directory) could pair them, at the cost of
  sometimes guessing.
- **Memory.** The whole tree is in memory and JSON is one string. For tens of
  millions of files I'd write NDJSON or a binary format streamed in sorted path
  order, so diff could be a streaming merge of two files, or store nodes in
  SQLite keyed by hash, which also deduplicates identical subtrees across snapshots.
- **Incremental snapshots.** Reuse the previous snapshot: if a file's
  size + mtime + inode are unchanged, reuse its content hash instead of re-reading
  it (what `git status` does with its index). Most of the speed of fast mode,
  with the safety of full hashing.
- **Fast mode can report a false move.** In fast mode a file's hash is derived
  from size + mtime, so an unrelated deleted file and a new file that happen to
  have the same size and mtime (common for files written by one tool in the
  same second, or extracted from one archive) are paired as a move. Full
  hashing doesn't have this problem.
- **`--ignore a,b` splits on commas**, so a pattern that itself contains `,`
  can't be passed on the command line (the library's `ignore` array has no
  such limit). An escape syntax or a `--ignore-file` option would fix it.
- **Large added folders** are listed path by path; a `--collapse` option could
  print just the top folder with a count.
- Report owner/group changes, hard-link detection via `(dev, ino)`, Windows
  attributes, and an option for case-insensitive / Unicode-normalized comparison.
- A `--since` mode that diffs a saved snapshot against the live tree without
  writing a second file.
- **Snapshots are integrity-checked, not authenticated.** `deserialize`
  checks that a snapshot is well formed and that its hashes are consistent,
  but anyone who can edit the file can recompute those hashes and forge
  content: different file hashes, or a fake `unreadable` error that hides a
  real removal. Next step: sign snapshots (e.g. an HMAC with a key kept apart
  from the snapshot files) and verify the signature before diffing.
- **Store raw byte names** so that file names that are not valid UTF-8 can be
  snapshotted and diffed too, instead of being recorded as `invalidName` errors.
