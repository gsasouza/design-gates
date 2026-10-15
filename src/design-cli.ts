#!/usr/bin/env node
import { runDesign } from "./design/run.js";

const code = await runDesign(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  cwd: process.cwd(),
  clock: () => new Date(),
});
// Leave through the stdout callback so a large result is flushed first.
process.stdout.write("", () => process.exit(code));
