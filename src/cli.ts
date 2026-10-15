#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runCheck } from "./cli/run-check.js";
import { runDiff } from "./cli/run-diff.js";

const USAGE = `Usage: design-gates <command> [options] [paths...]

Commands:
  diff     Visual and semantic diff report
  check    Run the design rules over .pen files

diff options:
  --repo <path>       Repository to diff (default: current directory)
  --base <ref>        Base ref (default: merge-base of main and HEAD)
  --head <ref>        Head ref (default: the working tree)
  --out <dir>         Output directory (default: ./design-diff)
  --threshold <0..1>  Pixel colour threshold (default: 0.1)
  --scale <n>         Render scale (default: 1)
  --inline            Embed images in report.html

Exit code 0 whenever the diff ran (with or without changes); non-zero only on errors.

check options:
  --base <ref>         Compare against this ref (enables diff-aware rules such as DIF-001)
  --format <fmt>       agent (default), sarif or text
  --config <file>      Config file (default: design-gates.config.json at the repo root, if present)
  --update-baseline    Rewrite design-gates-baseline.json with the current violations
  --scope <id>         Add to rules.DIF-001.scope (repeatable)

Exit code 0 when no block violation remains, 1 when one does, 2 on usage or config errors.

  --help               Show this help
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
if (argv[0] === "check") {
  let checkArgs;
  try {
    checkArgs = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        base: { type: "string" },
        format: { type: "string" },
        config: { type: "string" },
        "update-baseline": { type: "boolean" },
        scope: { type: "string", multiple: true },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const v = checkArgs.values;
  const code = await runCheck({
    paths: checkArgs.positionals,
    ...(v.base !== undefined && { base: v.base }),
    ...(v.format !== undefined && { format: v.format }),
    ...(v.config !== undefined && { config: v.config }),
    ...(v["update-baseline"] !== undefined && { updateBaseline: v["update-baseline"] }),
    ...(v.scope !== undefined && { scope: v.scope }),
  });
  // Leave through the stdout callback so a large report is flushed first.
  process.stdout.write("", () => process.exit(code));
  await new Promise(() => undefined);
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
