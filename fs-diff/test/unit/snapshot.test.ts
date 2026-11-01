import { describe, expect, it } from "vitest";
import { directoryHash, sha256, type DirectoryNode, type FileNode } from "../../src/model.js";
import {
  buildSnapshot,
  createLimiter,
  deserialize,
  directory,
  file,
  fromObject,
  mapWithConcurrency,
  serialize,
  symlink,
  toSnapshotError,
  type TreeSpec,
} from "../../src/snapshot.js";

describe("fromObject", () => {
  it("builds files, directories and symlinks without storing content", () => {
    const snap = fromObject({
      "a.txt": "hello",
      bin: { "run.sh": file("#!/bin/sh", { mode: 0o755, mtimeMs: 42 }) },
      link: symlink("a.txt"),
    });
    expect(snap.root.children.map((c) => c.name)).toEqual(["a.txt", "bin", "link"]);
    const a = snap.root.children[0] as FileNode;
    expect(a).toEqual({ type: "file", name: "a.txt", size: 5, mtimeMs: 0, mode: 0o644, contentHash: sha256("hello") });
    const run = (snap.root.children[1] as DirectoryNode).children[0] as FileNode;
    expect(run.mode).toBe(0o755);
    expect(run.mtimeMs).toBe(42);
    expect(snap.root.children[2]).toEqual({ type: "symlink", name: "link", target: "a.txt" });
    expect(JSON.stringify(snap)).not.toContain("hello");
  });

  it("produces the same root hash for the same tree built in a different insertion order", () => {
    const one = fromObject({ z: "1", a: { y: "2", b: "3" }, m: symlink("z") });
    const two = fromObject({ m: symlink("z"), a: { b: "3", y: "2" }, z: "1" });
    expect(one.root.hash).toBe(two.root.hash);
  });

  it("accepts raw bytes as file content", () => {
    const bytes = Uint8Array.of(0, 255, 10);
    expect(fromObject({ b: file(bytes) }).root.children[0]).toMatchObject({ size: 3, contentHash: sha256(bytes) });
  });

  it("hashes byte length, not string length, for unicode content", () => {
    const snap = fromObject({ "ü.txt": "héllo 🌍" });
    expect((snap.root.children[0] as FileNode).size).toBe(Buffer.byteLength("héllo 🌍"));
  });
});

describe("serialize / deserialize", () => {
  it("round-trips losslessly", () => {
    const clean = fromObject(
      {
        "a.txt": file("x", { mtimeMs: 1730000000123.4567, mode: 0o600 }),
        "日本語": { "über.md": "ü", empty: {} },
        link: symlink("../outside"),
      },
      { createdAt: "2026-01-01T00:00:00.000Z" },
    );
    clean.errors.push({ path: "secret", kind: "unreadable", code: "EACCES", message: "permission denied" });
    expect(deserialize(serialize(clean))).toEqual(clean);
    expect(deserialize(serialize(clean, true))).toEqual(clean);
  });

  it("rejects a tampered snapshot", () => {
    const clean = fromObject({ d: { "a.txt": "1" } });
    const tampered = JSON.parse(serialize(clean));
    tampered.root.children[0].children[0].contentHash = sha256("2");
    expect(() => deserialize(JSON.stringify(tampered))).toThrow(/hash mismatch/);
  });

  it.each([[0], [2], ["1"], [1.5], [undefined]])("rejects snapshot version %j with a clear message", (version) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.version = version;
    expect(() => deserialize(JSON.stringify(json))).toThrow(/unsupported snapshot version: .* reads version 1; take the snapshot again/);
  });

  it("gives a future version with new fields the version message, not an unknown-field error", () => {
    const json = JSON.parse(serialize(fromObject({})));
    json.version = 2;
    json.signature = "abc";
    expect(() => deserialize(JSON.stringify(json))).toThrow(
      "unsupported snapshot version: 2 (this version of fsdiff reads version 1; take the snapshot again)",
    );
  });

  it("escapes terminal-unsafe characters in its JSON and still round-trips exactly", () => {
    const snap = fromObject({ "x\u009B2J\u202E\u2028\u200B": symlink("t\u0085\u2066") });
    const json = serialize(snap);
    expect(json).not.toMatch(/[\u007F-\u009F\p{Cf}\u2028\u2029]/u);
    expect(deserialize(json)).toEqual(snap);
  });

  it.each([
    ["missing", undefined],
    ["an array", []],
    ["without ignore", { fast: false }],
    ["with a non-array ignore", { ignore: "x", fast: false }],
    ["with a non-boolean fast", { ignore: [], fast: "no" }],
  ])("rejects options that are %s", (_, options) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.options = options;
    expect(() => deserialize(JSON.stringify(json))).toThrow("invalid snapshot: bad options");
  });

  it.each([["socket"], [undefined], [1]])("rejects a node of unknown type %j", (type) => {
    const json = JSON.parse(serialize(fromObject({ a: "1" })));
    json.root.children[0].type = type;
    expect(() => deserialize(JSON.stringify(json))).toThrow(`invalid snapshot: root/.[0] has unknown type ${String(type)}`);
  });

  it.each([["[]"], ["null"], ["42"], ['"text"']])("rejects %s, which is not an object", (json) => {
    expect(() => deserialize(json)).toThrow("invalid snapshot: not an object");
  });

  it.each([[undefined], [{}], ["x"]])("rejects errors %j, which is not an array", (errors) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.errors = errors;
    expect(() => deserialize(JSON.stringify(json))).toThrow("invalid snapshot: errors must be an array");
  });

  it("rejects a root that is a file", () => {
    const json = JSON.parse(serialize(fromObject({ a: "1" })));
    json.root = { ...json.root.children[0], name: "" };
    expect(() => deserialize(JSON.stringify(json))).toThrow("invalid snapshot: root must be a directory");
  });

  it.each([[null], ["a"], [[1]]])("rejects a child %j that is not an object", (child) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.root.children = [child];
    expect(() => deserialize(JSON.stringify(json))).toThrow("invalid snapshot: root/.[0] is not an object");
  });

  it.each([[undefined], [{}], ["x"]])("rejects directory children %j that are not an array", (children) => {
    const json = JSON.parse(serialize(fromObject({ d: {} })));
    json.root.children[0].children = children;
    expect(() => deserialize(JSON.stringify(json))).toThrow("invalid snapshot: root/.[0].children is not an array");
  });

  it("rejects malformed nodes", () => {
    const bad = JSON.parse(serialize(fromObject({ a: "1" })));
    bad.root.children[0].size = "big";
    expect(() => deserialize(JSON.stringify(bad))).toThrow(/size/);
  });

  describe("rejects entry names that could inject paths into the diff", () => {
    /** A snapshot whose single child is renamed to `name`, with every hash recomputed so only the name is wrong. */
    function withChildName(name: string, kind: "file" | "dir"): string {
      const json = JSON.parse(serialize(fromObject(kind === "file" ? { a: "1" } : { a: { b: "1" } })));
      json.root.children[0].name = name;
      json.root.hash = directoryHash(json.root.children);
      return JSON.stringify(json);
    }

    it.each([[""], ["."], [".."], ["a/b"], ["../../etc/passwd"], ["/abs"], ["nul\0byte"]])("rejects %j", (name) => {
      expect(() => deserialize(withChildName(name, "file"))).toThrow(/is not a valid entry name/);
      expect(() => deserialize(withChildName(name, "dir"))).toThrow(/is not a valid entry name/);
    });

    it("rejects a bad name deeper in the tree", () => {
      const json = JSON.parse(serialize(fromObject({ d: { ok: "1" } })));
      json.root.children[0].children[0].name = "..";
      expect(() => deserialize(JSON.stringify(json))).toThrow(/root\/\.\[0\]\/d\[0\]\.name "\.\." is not a valid entry name/);
    });

    it("accepts names that only look unusual", () => {
      const snap = fromObject({ "...": "1", ".hidden": "2", "a\\b": "3", " ": "4" });
      expect(deserialize(serialize(snap))).toEqual(snap);
    });
  });

  describe("rejects numbers a real file system can't produce", () => {
    /** A one-file snapshot with `field` of the file set to `value`, with the root hash recomputed. */
    function withFileField(field: "size" | "mode", value: number): string {
      const json = JSON.parse(serialize(fromObject({ a: "1" })));
      json.root.children[0][field] = value;
      json.root.hash = directoryHash(json.root.children);
      return JSON.stringify(json);
    }

    // JSON.stringify can't write Infinity, so those cases put a placeholder in the
    // JSON and swap it for 1e400, which JSON.parse reads back as Infinity.
    it.each([[-1], [1.5], [2 ** 53]])("size %d", (size) => {
      expect(() => deserialize(withFileField("size", size))).toThrow(/size must be a non-negative integer/);
    });

    it("size Infinity", () => {
      const json = JSON.parse(serialize(fromObject({ a: "1" })));
      json.root.children[0].size = "__inf__";
      expect(() => deserialize(JSON.stringify(json).replace('"__inf__"', "1e400"))).toThrow(/size must be a non-negative integer/);
    });

    it.each([[-1], [0.5], [0o10000], [2 ** 40]])("file mode %d", (mode) => {
      expect(() => deserialize(withFileField("mode", mode))).toThrow(/mode must be an integer from 0 to 0o7777/);
    });

    it.each([[-1], [0.5], [0o10000]])("directory mode %d", (mode) => {
      const json = JSON.parse(serialize(fromObject({ d: {} })));
      json.root.children[0].mode = mode;
      json.root.hash = directoryHash(json.root.children);
      expect(() => deserialize(JSON.stringify(json))).toThrow(/root\/\.\[0\]\.mode must be an integer/);
    });

    it("root mode Infinity", () => {
      const json = JSON.parse(serialize(fromObject({})));
      json.root.mode = "__inf__";
      expect(() => deserialize(JSON.stringify(json).replace('"__inf__"', "1e400"))).toThrow(/root\.mode must be an integer/);
    });

    it.each([["1e400"], ["-1e400"]])("mtimeMs %s", (mtime) => {
      const json = JSON.parse(serialize(fromObject({ a: "1" })));
      json.root.children[0].mtimeMs = "__inf__";
      expect(() => deserialize(JSON.stringify(json).replace('"__inf__"', mtime))).toThrow(/mtimeMs must be finite/);
    });

    it("accepts fractional and pre-1970 mtimes", () => {
      for (const mtimeMs of [-86_400_000.5, 1730000000123.4567]) {
        const snap = fromObject({ a: file("1", { mtimeMs }) });
        expect(deserialize(serialize(snap))).toEqual(snap);
      }
    });
  });

  describe("validates errors[]", () => {
    const withErrors = (errors: unknown[]) => {
      const json = JSON.parse(serialize(fromObject({})));
      json.errors = errors;
      return JSON.stringify(json);
    };

    it.each([[""], ["/abs"], ["a//b"], ["a/"], [".."], ["../../etc/passwd"], ["a/./b"], ["nul\0byte"]])("rejects path %j", (badPath) => {
      expect(() => deserialize(withErrors([{ path: badPath, kind: "unreadable", message: "m" }]))).toThrow(
        /errors\[0\]\.path .* is not a valid relative path/,
      );
    });

    it.each([[undefined], ["unknown"], ["UNREADABLE"], [1]])("rejects kind %j", (kind) => {
      expect(() => deserialize(withErrors([{ path: "a", kind, message: "m" }]))).toThrow(/errors\[0\]\.kind must be one of/);
    });

    it.each([[undefined], [1], [null]])("rejects message %j", (message) => {
      expect(() => deserialize(withErrors([{ path: "a", kind: "unreadable", message }]))).toThrow(/errors\[0\]\.message must be a string/);
    });

    it.each([
      ["a\\xff"], // lower-case hex is never produced
      ["a\\x4"], // truncated escape
      ["a\\q"], // unknown escape
      ["plain"], // no escape: a valid name
      ["a\\x41"], // decodes to "aA", which is valid UTF-8
      ["\\xC3\\xA9"], // decodes to "é", valid UTF-8
      ["a\\xFF\\"], // lone trailing backslash
      ["d\\xFF/x"], // the escape must be the last segment
    ])("rejects invalidName path %j that is not in the escape format", (badPath) => {
      expect(() => deserialize(withErrors([{ path: badPath, kind: "invalidName", message: "m" }]))).toThrow(
        /errors\[0\]\.path .* is not a valid relative path/,
      );
    });

    it("accepts valid escaped invalidName paths, nested or not", () => {
      const errors = [
        { path: "a\\xFF", kind: "invalidName", message: "m" },
        { path: "sub/dir/x\\\\y\\xC3", kind: "invalidName", message: "m" },
        { path: "sub/ok", kind: "unreadable", code: "EIO", message: "m" },
      ];
      expect(deserialize(withErrors(errors)).errors).toEqual(errors);
    });
  });

  describe("symlink targets", () => {
    /** A snapshot whose single symlink `l` has `fields` overwritten, with the root hash recomputed. */
    function withLinkFields(fields: Record<string, unknown>): string {
      const json = JSON.parse(serialize(fromObject({ l: symlink("ok") })));
      Object.assign(json.root.children[0], fields);
      json.root.hash = directoryHash(json.root.children);
      return JSON.stringify(json);
    }

    it("round-trips an escaped target", () => {
      const snap = fromObject({ l: symlink(Uint8Array.of(0x61, 0xff)) });
      expect(snap.root.children[0]).toEqual({ type: "symlink", name: "l", target: "a\\xFF", targetEscaped: true });
      expect(deserialize(serialize(snap))).toEqual(snap);
    });

    it.each([[""], ["a\0b"]])("rejects target %j", (target) => {
      expect(() => deserialize(withLinkFields({ target }))).toThrow(/target must be non-empty and contain no NUL byte/);
    });

    it.each([
      [{ target: "a\\xFF", targetEscaped: false }],
      [{ target: "a\\xFF", targetEscaped: "yes" }],
      [{ target: "plain", targetEscaped: true }], // valid UTF-8 is never escaped
      [{ target: "a\\x41", targetEscaped: true }], // decodes to valid UTF-8
      [{ target: "a\\xff", targetEscaped: true }], // lower-case hex is never produced
    ])("rejects %j", (fields) => {
      expect(() => deserialize(withLinkFields(fields))).toThrow(/targetEscaped must be true and its target in the escape format/);
    });
  });

  describe("rejects unknown fields, naming them", () => {
    const snap = fromObject({ f: "1", d: {}, l: symlink("t") }); // root children sorted: d, f, l
    snap.errors.push({ path: "x", kind: "unreadable", code: "EIO", message: "m" });

    it.each([
      ["the snapshot", [], "extra", /invalid snapshot: snapshot has unknown field "extra"/],
      ["options", ["options"], "extra", /invalid snapshot: options has unknown field "extra"/],
      ["an error", ["errors", 0], "extra", /invalid snapshot: errors\[0\] has unknown field "extra"/],
      ["the root", ["root"], "size", /invalid snapshot: root has unknown field "size"/],
      ["a directory", ["root", "children", 0], "target", /root\/\.\[0\] has unknown field "target"/],
      ["a file (targetEscaped)", ["root", "children", 1], "targetEscaped", /root\/\.\[1\] has unknown field "targetEscaped"/],
      ["a file (children)", ["root", "children", 1], "children", /root\/\.\[1\] has unknown field "children"/],
      ["a symlink", ["root", "children", 2], "children", /root\/\.\[2\] has unknown field "children"/],
      ["an own __proto__ key", ["options"], "__proto__", /options has unknown field "__proto__"/],
    ])("on %s", (_, at: Array<string | number>, field, message) => {
      const json = JSON.parse(serialize(snap));
      let target = json;
      for (const key of at) target = target[key];
      // defineProperty, so "__proto__" becomes an own field as JSON.parse would make it.
      Object.defineProperty(target, field, { value: true, enumerable: true, writable: true, configurable: true });
      expect(() => deserialize(JSON.stringify(json))).toThrow(message);
    });
  });

  it.each([[[1]], [[null]], [[{}]], [["ok", 2]]])("rejects non-string ignore items %j", (ignore) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.options.ignore = ignore;
    expect(() => deserialize(JSON.stringify(json))).toThrow(/options\.ignore must contain only strings/);
  });
});

describe("createLimiter", () => {
  it("never runs more than max tasks at once", async () => {
    const limit = createLimiter(3);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    };
    await Promise.all(Array.from({ length: 50 }, () => limit(task)));
    expect(peak).toBe(3);
  });
});

describe("fromObject and deserialize share one set of node rules", () => {
  type Shape = "file" | "symlink" | "directory";
  const bases: Record<Shape, TreeSpec[string]> = { file: "1", symlink: symlink("t"), directory: directory({}, { mode: 0o755 }) };

  /**
   * Each case: a tree fromObject must reject, and the same bad value written
   * into the JSON of a valid snapshot with one node of the same shape (hashes
   * recomputed, so only that value is wrong). Both must report the same problem.
   * JSON can't hold NaN or Infinity, so "__inf__" is swapped for 1e400 (Infinity).
   */
  const cases: Array<[string, TreeSpec, Shape, string, unknown, string]> = [
    ["name .", { ".": "1" }, "file", "name", ".", 'name "." is not a valid entry name'],
    ["name ..", { "..": "1" }, "file", "name", "..", 'name ".." is not a valid entry name'],
    ["an empty name", { "": "1" }, "file", "name", "", 'name "" is not a valid entry name'],
    ["a name with /", { "a/b": {} }, "directory", "name", "a/b", 'name "a/b" is not a valid entry name'],
    ["a name with NUL", { "a\0b": "1" }, "file", "name", "a\0b", 'name "a\\u0000b" is not a valid entry name'],
    ["an empty target", { a: symlink("") }, "symlink", "target", "", "target must be non-empty and contain no NUL byte"],
    ["the internal NUL prefix", { a: symlink("\0escaped:a\\xFF") }, "symlink", "target", "\0escaped:a\\xFF", "contain no NUL byte"],
    ["a negative mode", { a: file("1", { mode: -1 }) }, "file", "mode", -1, "mode must be an integer from 0 to 0o7777, got -1"],
    ["a fractional mode", { a: file("1", { mode: 0.5 }) }, "file", "mode", 0.5, "mode must be an integer from 0 to 0o7777, got 0.5"],
    ["a mode above 0o7777", { a: file("1", { mode: 0o10000 }) }, "file", "mode", 0o10000, "got 4096"],
    ["a directory mode above 0o7777", { a: directory({}, { mode: 0o10000 }) }, "directory", "mode", 0o10000, "got 4096"],
    ["an infinite mtime", { a: file("1", { mtimeMs: Infinity }) }, "file", "mtimeMs", "__inf__", "mtimeMs must be finite, got Infinity"],
  ];

  it.each(cases)("both reject %s", (_, spec, shape, field, value, problem) => {
    expect(() => fromObject(spec)).toThrow(TypeError);
    expect(() => fromObject(spec)).toThrow(problem);

    const json = JSON.parse(serialize(fromObject({ a: bases[shape] })));
    json.root.children[0][field] = value;
    json.root.hash = directoryHash(json.root.children);
    expect(() => deserialize(JSON.stringify(json).replace('"__inf__"', "1e400"))).toThrow(problem);
  });

  it("checks the root mode too", () => {
    expect(() => fromObject({}, { rootMode: 0o10000 })).toThrow('invalid tree spec at "": mode must be an integer');
  });

  it("names the full path of a bad nested entry", () => {
    expect(() => fromObject({ d: { e: { "..": "1" } } })).toThrow('invalid tree spec at "d/e/..": name ".." is not a valid entry name');
  });
});

describe("deserialize validates error entries", () => {
  const withErrors = (errors: unknown[]) => {
    const json = JSON.parse(serialize(fromObject({})));
    json.errors = errors;
    return JSON.stringify(json);
  };

  it.each([[null], ["not-an-error"], [{ bogus: 123 }], [{ path: "a", kind: "unreadable", message: 1 }], [{ path: "a", kind: "unreadable", message: "m", code: 5 }]])(
    "rejects %j",
    (entry) => {
      expect(() => deserialize(withErrors([entry]))).toThrow(/invalid snapshot: errors\[0\]/);
    },
  );

  it("accepts well-formed entries with and without a code", () => {
    const errors = [
      { path: "a", kind: "unreadable", code: "EACCES", message: "denied" },
      { path: "b", kind: "unsupported", message: "unsupported" },
    ];
    expect(deserialize(withErrors(errors)).errors).toEqual(errors);
  });
});

describe("mapWithConcurrency", () => {
  it("never has more than max calls in progress and keeps order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6, 7, 8, 9], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60, 70, 80, 90]);
  });
});

describe("toSnapshotError", () => {
  it("has no code for an Error without one, or with a code that is not a string", () => {
    expect(toSnapshotError("p", new Error("plain"))).toEqual({ path: "p", kind: "unreadable", message: "plain" });
    expect(toSnapshotError("p", Object.assign(new Error("odd"), { code: 5 }))).toEqual({ path: "p", kind: "unreadable", message: "odd" });
  });

  it.each([[null], [undefined], ["a string"], [42]])("does not crash on %j", (thrown) => {
    expect(toSnapshotError("p", thrown)).toEqual({ path: "p", kind: "unreadable", message: String(thrown) });
  });

  it("keeps the code of a Node error", () => {
    const err = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(toSnapshotError("p", err)).toEqual({ path: "p", kind: "unreadable", code: "EACCES", message: "denied" });
  });
});

describe("fromObject with invalid values in a tree spec", () => {
  it.each([[null], [123], [true], [undefined]])("give a clear error for %j", (value) => {
    expect(() => fromObject({ a: value as never })).toThrow(/invalid tree spec at "a"/);
  });
});

describe("limiter concurrency", () => {
  it.each([[0], [-1], [1.5], [Number.NaN]])("rejects %j instead of deadlocking", (max) => {
    expect(() => createLimiter(max)).toThrow(RangeError);
  });

  it("rejects a bad concurrency option in buildSnapshot", async () => {
    await expect(buildSnapshot(".", { concurrency: 0 })).rejects.toThrow(RangeError);
  });
});
