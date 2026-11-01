/**
 * The command-line interface, without touching `process`: arguments come in,
 * output goes through `io`, and the exit code is returned. `src/cli.ts` is the
 * bin entry that wires this to the real process.
 *
 *   fsdiff snapshot <dir> [-o snap.json] [--ignore <pattern>]... [--fast] [--pretty]
 *   fsdiff diff <before.json> <after.json> [--json] [--mtime] [--no-moves]
 *
 * Exit codes follow diff(1): 0 = no differences, 1 = differences, 2 = error.
 */
import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { diff } from "../diff.js";
import type { SnapshotError } from "../model.js";
import { escapeJsonForTerminal, formatMessage, formatPath } from "../quote.js";
import { formatReport } from "../report.js";
import { buildSnapshot, deserialize, serialize } from "../snapshot.js";

/** Where the CLI writes. Each call gets complete text; nothing is added. */
export interface CliIo {
  /**
   * May return a promise that settles once the text is written; a rejection
   * means it was not (fully) written, e.g. EPIPE when the reader closed the pipe.
   */
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void;
}

const USAGE = `Usage:
  fsdiff snapshot <dir> [-o <file>] [--ignore <pattern>]... [--fast] [--pretty]
      Scan <dir> and write a snapshot as JSON (to stdout if -o is omitted).
      --ignore  name or glob to skip; repeatable or comma-separated (e.g. node_modules,.git)
      --fast    hash size + mtime instead of file contents (faster, less precise)
      --pretty  indent the JSON

  fsdiff diff <before.json> <after.json> [--json] [--mtime] [--no-moves]
      Compare two snapshots.
      --json      print the full result as JSON
      --mtime     also report files whose only change is mtime
      --no-moves  report renames as separate add + remove`;

async function snapshotCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      ignore: { type: "string", multiple: true },
      fast: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
  });
  const [dir] = positionals;
  if (dir === undefined || positionals.length !== 1) return usageError(io, "snapshot needs exactly one directory");
  // path.resolve("") is the current directory, and an empty -o would mean stdout: neither is what was asked.
  if (dir === "") return usageError(io, "the directory must not be an empty string");
  if (values.output === "") return usageError(io, "-o needs a file name, not an empty string");

  const ignore = (values.ignore ?? []).flatMap((p) => p.split(",")).filter((p) => p.trim() !== "");
  const snapshot = await buildSnapshot(dir, { ignore, fast: values.fast });
  const json = serialize(snapshot, values.pretty);

  if (values.output !== undefined) {
    await fs.writeFile(values.output, json + "\n");
  } else {
    try {
      await io.stdout(json + "\n");
    } catch (err) {
      // A partial snapshot is useless, so even a reader that just stopped early (EPIPE) is an error here.
      throw new Error(`could not write the whole snapshot to stdout (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  for (const e of snapshot.errors) {
    if (e.kind === "unsupported") io.stderr(`warning: ${formatErrorPath(e)}: ${formatMessage(e.message)}\n`);
    else io.stderr(`warning: could not read ${formatErrorPath(e)}: ${formatMessage(e.code ?? e.message)}\n`);
  }
  if (values.output !== undefined) {
    io.stderr(`Wrote snapshot of ${formatPath(snapshot.rootPath)} to ${formatPath(values.output)}\n`);
  }
  return 0;
}

async function diffCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      mtime: { type: "boolean", default: false },
      "no-moves": { type: "boolean", default: false },
    },
  });
  const [beforeFile, afterFile] = positionals;
  if (beforeFile === undefined || afterFile === undefined || positionals.length !== 2) {
    return usageError(io, "diff needs two snapshot files");
  }
  if (beforeFile === "" || afterFile === "") return usageError(io, "a snapshot file name must not be an empty string");

  const load = async (file: string) => deserialize(await fs.readFile(file, "utf8"));
  const [before, after] = await Promise.all([load(beforeFile), load(afterFile)]);
  const result = diff(before, after, { compareMtime: values.mtime, detectMoves: !values["no-moves"] });

  if (values.json) {
    await writeResult(io, escapeJsonForTerminal(JSON.stringify(result, null, 2)) + "\n");
  } else {
    for (const w of result.warnings) io.stderr(`warning: ${formatMessage(w)}\n`);
    await writeResult(io, formatReport(result) + "\n");
  }
  return result.summary.total === 0 ? 0 : 1;
}

/**
 * Writes a diff result. A reader that stops early (`fsdiff diff a b | head`)
 * is not an error: the exit code still says whether anything changed. Any
 * other write failure is.
 */
async function writeResult(io: CliIo, text: string): Promise<void> {
  try {
    await io.stdout(text);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE") return;
    throw err;
  }
}

/** An error path, with an invalid-UTF-8 last segment shown as raw bytes (see formatPath). */
function formatErrorPath(error: SnapshotError): string {
  return error.kind === "invalidName" ? formatPath(error.path, error.path.lastIndexOf("/") + 1) : formatPath(error.path);
}

function usageError(io: CliIo, message: string): number {
  io.stderr(`error: ${message}\n\n${USAGE}\n`);
  return 2;
}

/**
 * Runs one command. Never throws unless the injected `io` itself throws: any
 * other error is printed to `io.stderr` and gives exit code 2.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "snapshot":
        return await snapshotCommand(rest, io);
      case "diff":
        return await diffCommand(rest, io);
      case "-h":
      case "--help":
      case undefined:
        // No command is a usage error, so the help goes to stderr; asking for it is not.
        if (command !== undefined) {
          io.stdout(`${USAGE}\n`);
          return 0;
        }
        io.stderr(`${USAGE}\n`);
        return 2;
      default:
        return usageError(io, `unknown command ${formatPath(command)}`);
    }
  } catch (err) {
    io.stderr(`error: ${formatMessage(err instanceof Error ? err.message : String(err))}\n`);
    return 2;
  }
}
