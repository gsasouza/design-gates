#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDiff } from "./cli/run-diff.js";

const USAGE = `Usage: design-gates diff [options] [paths...]

Options:
  --repo <path>       Repository to diff (default: current directory)
  --base <ref>        Base ref (default: merge-base of main and HEAD)
  --head <ref>        Head ref (default: the working tree)
  --out <dir>         Output directory (default: ./design-diff)
  --threshold <0..1>  Pixel colour threshold (default: 0.1)
  --scale <n>         Render scale (default: 1)
  --inline            Embed images in report.html
  --help              Show this help

Exit code 0 whenever the diff ran (with or without changes); non-zero only on errors.
`;

function fail(message: string): never {
  process.stderr.write(`design-gates: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (argv[0] !== "diff") fail(argv[0] === undefined ? "missing command" : `unknown command "${argv[0]}"`);

let parsed;
try {
  parsed = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      out: { type: "string" },
      threshold: { type: "string" },
      scale: { type: "string" },
      inline: { type: "boolean" },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;
const num = (flag: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = v.trim() === "" ? NaN : Number(v);
  if (Number.isNaN(n)) fail(`${flag} must be a number, got "${v}"`);
  return n;
};

process.exitCode = await runDiff({
  ...(values.repo !== undefined && { repo: values.repo }),
  ...(values.base !== undefined && { base: values.base }),
  ...(values.head !== undefined && { head: values.head }),
  ...(values.out !== undefined && { out: values.out }),
  ...(values.inline !== undefined && { inline: values.inline }),
  ...(values.threshold !== undefined && { threshold: num("--threshold", values.threshold)! }),
  ...(values.scale !== undefined && { scale: num("--scale", values.scale)! }),
  paths: positionals,
});
