#!/usr/bin/env node
/** Bin entry: runs the CLI against the real process. All logic is in cli/run.ts. */
import { run } from "./cli/run.js";

// A stdout failure (EPIPE when the reader closes the pipe early, ENOSPC, ...)
// reaches run() through the write callback below, and run() decides what it
// means for the command. The listener only stops Node from crashing on the
// 'error' event. On stderr there is nowhere left to report a failure, so a
// closed stderr just stops further writes; the exit code is unaffected.
process.stdout.on("error", () => {});
let stderrClosed = false;
process.stderr.on("error", () => {
  stderrClosed = true;
});

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => new Promise((resolve, reject) => process.stdout.write(text, (err) => (err ? reject(err) : resolve()))),
  stderr: (text) => {
    if (!stderrClosed) process.stderr.write(text);
  },
});
