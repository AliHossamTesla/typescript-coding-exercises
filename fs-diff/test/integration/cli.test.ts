import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";
import { fromObject, serialize, type TreeSpec } from "../../src/snapshot.js";

/** Runs the CLI in-process and captures what it writes. */
async function cli(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const status = await run(args, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { status, stdout, stderr };
}

/** Runs the CLI in-process with a stdout that fails every write with `code`. */
async function cliWithFailingStdout(code: string, ...args: string[]): Promise<{ status: number; stderr: string }> {
  let stderr = "";
  const status = await run(args, {
    stdout: () => Promise.reject(Object.assign(new Error(`write ${code}`), { code })),
    stderr: (t) => {
      stderr += t;
    },
  });
  return { status, stderr };
}

/** Any character that must never reach the terminal raw; output lines end with the CLI's own newlines. */
const RAW_UNSAFE = /[\x00-\x09\x0B-\x1F\x7F-\x9F\p{Cf}\p{Zl}\p{Zp}]/u;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let work: string;
let dir: string;
const at = (name: string) => path.join(work, name);

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "fsdiff-cli-"));
  dir = at("tree");
  await fs.mkdir(dir);
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe("run: snapshot", () => {
  it("writes to -o and says where, or to stdout without -o", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one");
    const toFile = await cli("snapshot", dir, "-o", at("1.json"));
    expect(toFile).toEqual({ status: 0, stdout: "", stderr: `Wrote snapshot of ${dir} to ${at("1.json")}\n` });

    const toStdout = await cli("snapshot", dir, "--pretty");
    expect(toStdout.status).toBe(0);
    expect(toStdout.stderr).toBe("");
    expect(toStdout.stdout).toMatch(/^\{\n {2}"version": 1,/);
    expect(JSON.parse(toStdout.stdout).root).toEqual(JSON.parse(await fs.readFile(at("1.json"), "utf8")).root);
  });

  it("splits --ignore on commas, accepts it repeated, and drops empty patterns", async () => {
    for (const name of ["a.txt", "b.log", "c.tmp", "keep"]) await fs.writeFile(path.join(dir, name), name);
    const r = await cli("snapshot", dir, "--ignore", "a.txt,,*.log", "--ignore", "c.tmp", "--fast");
    const snap = JSON.parse(r.stdout);
    expect(snap.options).toEqual({ ignore: ["a.txt", "*.log", "c.tmp"], fast: true });
    expect(snap.root.children.map((c: { name: string }) => c.name)).toEqual(["keep"]);
  });

  it.skipIf(process.platform === "win32")("prints a warning per snapshot error, by kind", async () => {
    spawnSync("mkfifo", [path.join(dir, "pipe")]);
    const r = await cli("snapshot", dir, "-o", at("1.json"));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(
      `warning: pipe: unsupported file type (socket, FIFO or device); skipped\nWrote snapshot of ${dir} to ${at("1.json")}\n`,
    );
  });

  it.each([[[]], [["a", "b"]]])("needs exactly one directory (got %j)", async (dirs) => {
    const r = await cli("snapshot", ...dirs);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^error: snapshot needs exactly one directory\n\nUsage:/);
  });
});

describe("run: diff", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(path.join(dir, "node_modules", "dep.js"), "x");
    await fs.writeFile(path.join(dir, "a.txt"), "one");
    await cli("snapshot", dir, "-o", at("1.json"), "--ignore", "node_modules");
    await fs.writeFile(path.join(dir, "a.txt"), "two");
    await fs.writeFile(path.join(dir, "node_modules", "dep.js"), "changed but ignored");
    await fs.writeFile(path.join(dir, "b.txt"), "new");
    await cli("snapshot", dir, "-o", at("2.json"), "--ignore", "node_modules");
  });

  it("prints the report and exits with 1 when something changed", async () => {
    expect(await cli("diff", at("1.json"), at("2.json"))).toEqual({
      status: 1,
      stdout: [
        "~ a.txt  content changed (3 B -> 3 B)",
        "+ b.txt",
        "",
        "2 change(s): 1 added, 0 removed, 1 modified, 0 metadata changed, 0 type changed, 0 moved.",
        "Visited 3 node(s), skipped 0 identical subtree(s).",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("exits with 0 when nothing changed", async () => {
    const r = await cli("diff", at("2.json"), at("2.json"));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^No differences\.\n/);
  });

  it("prints the full result with --json", async () => {
    const r = await cli("diff", at("1.json"), at("2.json"), "--json");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).summary).toEqual({
      added: 1,
      removed: 0,
      modified: 1,
      metadataChanged: 0,
      typeChanged: 0,
      moved: 0,
      total: 2,
    });
  });

  it("passes --mtime and --no-moves through", async () => {
    await fs.rename(path.join(dir, "b.txt"), path.join(dir, "c.txt"));
    await fs.utimes(path.join(dir, "a.txt"), 1, 1);
    await cli("snapshot", dir, "-o", at("3.json"), "--ignore", "node_modules");

    const plain = JSON.parse((await cli("diff", at("2.json"), at("3.json"), "--json")).stdout);
    expect(plain.summary).toMatchObject({ moved: 1, metadataChanged: 0, total: 1 });
    const flags = JSON.parse((await cli("diff", at("2.json"), at("3.json"), "--json", "--mtime", "--no-moves")).stdout);
    expect(flags.summary).toMatchObject({ added: 1, removed: 1, moved: 0, metadataChanged: 1, total: 3 });
  });

  it("prints diff warnings to stderr", async () => {
    await cli("snapshot", dir, "-o", at("3.json"));
    const r = await cli("diff", at("2.json"), at("3.json"));
    expect(r.stderr).toMatch(/^warning: snapshots used different ignore lists/);
  });

  it("needs two snapshot files", async () => {
    const r = await cli("diff", at("1.json"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^error: diff needs two snapshot files\n\nUsage:/);
  });
});

describe("run: empty arguments", () => {
  it.each([
    [["snapshot", ""], "the directory must not be an empty string"],
    [["snapshot", "DIR", "-o", ""], "-o needs a file name, not an empty string"],
    [["diff", "", "x.json"], "a snapshot file name must not be an empty string"],
    [["diff", "x.json", ""], "a snapshot file name must not be an empty string"],
  ])("rejects %j as a usage error", async (args, message) => {
    const r = await cli(...args.map((a) => (a === "DIR" ? dir : a)));
    expect(r).toMatchObject({ status: 2, stdout: "" });
    expect(r.stderr).toMatch(new RegExp(`^error: ${message}\n\nUsage:`));
  });
});

describe("run: untrusted text in messages", () => {
  it.skipIf(isRoot || process.platform === "win32")("prints the exact warning for an unreadable file", async () => {
    await fs.writeFile(path.join(dir, "secret"), "x");
    await fs.chmod(path.join(dir, "secret"), 0o000);
    const r = await cli("snapshot", dir, "-o", at("1.json"));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`warning: could not read secret: EACCES\nWrote snapshot of ${dir} to ${at("1.json")}\n`);
  });

  it("prints the exact warning for a name that is not valid UTF-8, with its bytes escaped in quotes", async (ctx) => {
    if (process.platform !== "linux") ctx.skip("Linux only: other platforms reject file names that are not valid UTF-8");
    try {
      await fs.writeFile(Buffer.concat([Buffer.from(`${dir}/a`), Buffer.of(0xff)]), "x");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EILSEQ" || code === "EINVAL") ctx.skip(`the temp file system rejects invalid UTF-8 names (${code})`);
      throw err;
    }
    const r = await cli("snapshot", dir, "-o", at("1.json"));
    expect(r.stderr).toBe(
      `warning: could not read "a\\xFF": file name is not valid UTF-8; skipped\nWrote snapshot of ${dir} to ${at("1.json")}\n`,
    );
  });

  it.skipIf(process.platform === "win32")("quotes hostile names in snapshot warnings and in the root and output paths", async () => {
    const hostileDir = at("t\x1b]0;title\x07");
    await fs.mkdir(hostileDir);
    spawnSync("mkfifo", [path.join(hostileDir, "p\n\x1b[2Kwarning: all good")]);
    const out = at("o\r.json");
    const r = await cli("snapshot", hostileDir, "-o", out);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(
      'warning: "p\\n\\x1B[2Kwarning: all good": unsupported file type (socket, FIFO or device); skipped\n' +
        `Wrote snapshot of "${work}/t\\x1B]0;title\\x07" to "${work}/o\\r.json"\n`,
    );
    expect(r.stderr).not.toMatch(RAW_UNSAFE);
  });

  it("escapes control characters and bidi overrides in diff warnings and error messages", async () => {
    const write = async (name: string, spec: TreeSpec, ignore: string[]) => {
      const snap = fromObject(spec);
      snap.options.ignore = ignore;
      await fs.writeFile(at(name), serialize(snap));
    };
    await write("a.json", { "x\u202Ey": "1" }, []);
    await write("b.json", {}, ["evil\u202E\x1b[2K"]);
    const r = await cli("diff", at("a.json"), at("b.json"));
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe('- "x\\u{202E}y"');
    expect(r.stderr).toBe(
      'warning: snapshots used different ignore lists ([] vs ["evil\\u{202E}\\u001b[2K"]); ignored paths may show up as added or removed\n',
    );

    const missing = await cli("diff", at("m\x1b[2K\n.json"), at("b.json"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe(`error: ENOENT: no such file or directory, open '${work}/m\\x1B[2K\\n.json'\n`);

    const command = await cli("diff\x1b[2K");
    expect(command.stderr).toMatch(/^error: unknown command "diff\\x1B\[2K"\n/);
    for (const output of [r.stdout, r.stderr, missing.stderr, command.stderr]) expect(output).not.toMatch(RAW_UNSAFE);
  });
});

describe("run: output that can't be written", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "1");
    await fs.writeFile(at("empty.json"), serialize(fromObject({})));
    await cli("snapshot", dir, "-o", at("1.json"));
  });

  it.each([["EPIPE"], ["ENOSPC"]])("snapshot to stdout fails with exit 2 and a message on %s", async (code) => {
    expect(await cliWithFailingStdout(code, "snapshot", dir)).toEqual({
      status: 2,
      stderr: `error: could not write the whole snapshot to stdout (write ${code})\n`,
    });
  });

  it("diff keeps its own exit code when the reader closes the pipe (EPIPE), text or --json", async () => {
    expect(await cliWithFailingStdout("EPIPE", "diff", at("empty.json"), at("1.json"))).toEqual({ status: 1, stderr: "" });
    expect(await cliWithFailingStdout("EPIPE", "diff", at("1.json"), at("1.json"), "--json")).toEqual({ status: 0, stderr: "" });
  });

  it("reports a write failure that is not an Error object too", async () => {
    const failing = async (...args: string[]) => {
      let stderr = "";
      const status = await run(args, {
        stdout: () => Promise.reject("disk on fire"),
        stderr: (t) => {
          stderr += t;
        },
      });
      return { status, stderr };
    };
    expect(await failing("snapshot", dir)).toEqual({
      status: 2,
      stderr: "error: could not write the whole snapshot to stdout (disk on fire)\n",
    });
    expect(await failing("diff", at("empty.json"), at("1.json"))).toEqual({ status: 2, stderr: "error: disk on fire\n" });
  });

  it("diff exits with 2 on any other write failure", async () => {
    expect(await cliWithFailingStdout("ENOSPC", "diff", at("empty.json"), at("1.json"))).toEqual({
      status: 2,
      stderr: "error: write ENOSPC\n",
    });
  });
});

describe("run: JSON output is terminal-safe", () => {
  const hostile = "x\u009B2J\u202Eevil\u2028\u200B\u007F.txt";

  it("escapes C1, DEL, bidi, zero-width and line separators in --json and snapshot output, and parses back exactly", async () => {
    await fs.writeFile(at("a.json"), serialize(fromObject({})));
    await fs.writeFile(at("b.json"), serialize(fromObject({ [hostile]: "1" })));
    const r = await cli("diff", at("a.json"), at("b.json"), "--json");
    expect(r.stdout).not.toMatch(RAW_UNSAFE);
    expect(r.stdout).toContain('"path": "x\\u009B2J\\u202Eevil\\u2028\\u200B\\u007F.txt"');
    expect(JSON.parse(r.stdout).added).toEqual([{ path: hostile, type: "file" }]);

    await fs.writeFile(path.join(dir, hostile), "1");
    const snap = await cli("snapshot", dir);
    expect(snap.stdout).not.toMatch(RAW_UNSAFE);
    expect(JSON.parse(snap.stdout).root.children[0].name).toBe(hostile);
  });
});

describe("run: errors and help", () => {
  it("exits with 2 and prints the message for a missing file, a bad snapshot or an unknown option", async () => {
    const missing = await cli("diff", at("missing-1.json"), at("missing-2.json"));
    expect(missing).toMatchObject({ status: 2, stdout: "" });
    expect(missing.stderr).toMatch(/^error: ENOENT: no such file or directory/);

    await fs.writeFile(at("bad.json"), "{}");
    expect(await cli("diff", at("bad.json"), at("bad.json"))).toEqual({
      status: 2,
      stdout: "",
      stderr: expect.stringMatching(/^error: unsupported snapshot version: missing/),
    });

    const option = await cli("snapshot", dir, "--nope");
    expect(option.status).toBe(2);
    expect(option.stderr).toMatch(/^error: Unknown option '--nope'/);
  });

  it("rejects an unknown command", async () => {
    const r = await cli("frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^error: unknown command frobnicate\n\nUsage:/);
  });

  it("prints usage to stdout with exit 0 for --help and -h, and to stderr with exit 2 for no command", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await cli(flag);
      expect(r).toEqual({ status: 0, stdout: expect.stringMatching(/^Usage:\n/), stderr: "" });
    }
    expect(await cli()).toEqual({ status: 2, stdout: "", stderr: expect.stringMatching(/^Usage:\n/) });
  });
});

describe("bin entry", () => {
  const bin = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), ...args], { encoding: "utf8" });

  it("passes argv to run and sets the process exit code from it", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "x");
    const snap = bin("snapshot", dir, "-o", at("1.json"));
    expect(snap.status).toBe(0);
    expect(snap.stderr).toBe(`Wrote snapshot of ${dir} to ${at("1.json")}\n`);
    const same = bin("diff", at("1.json"), at("1.json"));
    expect(same.status).toBe(0);
    expect(same.stdout).toMatch(/^No differences\./);
    expect(bin("frobnicate").status).toBe(2);

    await fs.writeFile(path.join(dir, "b.txt"), "y");
    bin("snapshot", dir, "-o", at("2.json"));
    const changed = bin("diff", at("1.json"), at("2.json"));
    expect(changed.status).toBe(1);
    expect(changed.stdout).toMatch(/^\+ b\.txt\n/);
  }, 30_000);

  it("stops quietly and keeps exit code 1 when the reader closes stdout early (| head)", async () => {
    // ~20,000 report lines: far more than a pipe buffer, so the CLI is still writing when the pipe closes.
    const many: TreeSpec = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`file-${i}.txt`, `${i}`]));
    await fs.writeFile(at("empty.json"), serialize(fromObject({})));
    await fs.writeFile(at("many.json"), serialize(fromObject(many)));

    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "diff", at("empty.json"), at("many.json")]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const firstChunk = await new Promise<string>((resolve) => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    child.stdout.destroy(); // what `head` does after its first lines
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(firstChunk).toMatch(/^\+ file-0\.txt\n/);
    expect(stderr).toBe("");
    expect(status).toBe(1);
  }, 30_000);

  /** Runs `fsdiff <args> <redirect> | head <headArgs>` in bash and returns the CLI's own exit code and bash's stderr. */
  const throughHead = (args: string[], redirect: string, headArgs: string) =>
    spawnSync(
      "bash",
      ["-c", `"$0" --import tsx "$@" ${redirect} | head ${headArgs}; exit "\${PIPESTATUS[0]}"`, process.execPath, path.resolve("src/cli.ts"), ...args],
      { encoding: "utf8" },
    );

  it.skipIf(process.platform === "win32")("2>&1 | head -0: a closed stderr is quiet and keeps the exit code", async () => {
    // ~3,000 warning lines on stderr: far more than a pipe buffer.
    execFileSync("bash", ["-c", 'cd "$0" && mkfifo p{1..3000}', dir]);
    const snap = throughHead(["snapshot", dir, "-o", at("1.json")], "2>&1", "-0");
    expect(snap.status).toBe(0);
    expect(snap.stderr).toBe("");

    // An identical diff with a warning (different ignore lists) must still exit 0, not 1.
    await fs.writeFile(at("plain.json"), serialize(fromObject({})));
    const ignoring = fromObject({});
    ignoring.options.ignore = ["x"];
    await fs.writeFile(at("ignoring.json"), serialize(ignoring));
    const same = throughHead(["diff", at("plain.json"), at("ignoring.json")], "2>&1", "-0");
    expect(same.status).toBe(0);
    expect(same.stderr).toBe("");
  }, 30_000);

  it.skipIf(process.platform === "win32")("snapshot | head -c 10: an undelivered snapshot exits 2 with a message", async () => {
    // ~2,000 entries of JSON: far more than a pipe buffer, so most of it can't be delivered.
    execFileSync("bash", ["-c", 'cd "$0" && touch f{1..2000}', dir]);
    const r = throughHead(["snapshot", dir], "", "-c 10");
    expect(r.stdout).toBe('{"version"');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("error: could not write the whole snapshot to stdout (write EPIPE)\n");
  }, 30_000);
});
