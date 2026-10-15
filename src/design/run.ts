import { parseArgs } from "node:util";
import path from "node:path";
import { compare as libCompare } from "../vcs/compare.js";
import type { CompareOptions, CompareDeps, CompareResult } from "../vcs/compare.js";
import { VcsCommitFailedError, VcsRefusedError, VcsUsageError } from "../vcs/errors.js";
import { createDesignRepo, type DesignRepo } from "../vcs/repo.js";
import type { DiffDeps } from "../cli/run-diff.js";
import { COMMANDS, MAIN_HELP, commandHelp, type Command } from "./help.js";

export interface DesignDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  clock?: () => Date;
  /** Opens the compare report in the system viewer. */
  opener?: (file: string) => Promise<void>;
  /** Seams for tests; the defaults are the real library. */
  createRepo?: (repo: string) => DesignRepo;
  compare?: (options: CompareOptions, deps: CompareDeps) => Promise<CompareResult>;
  diff?: DiffDeps;
}

const OPTIONS = {
  repo: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  message: { type: "string", short: "m" },
  limit: { type: "string" },
  out: { type: "string" },
  open: { type: "boolean" },
  "save-first": { type: "boolean" },
} as const;

/** Options each command accepts besides --repo, --json and --help. */
const OWN: Record<string, string[]> = {
  save: ["message"],
  history: ["limit"],
  compare: ["out", "open"],
  restore: ["save-first"],
};

const POSITIONALS: Record<string, { min: number; max: number; what: string }> = {
  init: { min: 0, max: 0, what: "" },
  status: { min: 0, max: 0, what: "" },
  save: { min: 0, max: 0, what: "" },
  history: { min: 0, max: 1, what: "a design file" },
  compare: { min: 0, max: Infinity, what: "" },
  restore: { min: 1, max: Infinity, what: "a version to go back to" },
  explore: { min: 0, max: 1, what: "an exploration name" },
  switch: { min: 1, max: 1, what: "an exploration name or main" },
};

const isCommand = (s: string): s is Command => (COMMANDS as readonly string[]).includes(s);

function exitCodeOf(err: unknown): number {
  if (err instanceof VcsUsageError) return 2;
  if (err instanceof VcsRefusedError || err instanceof VcsCommitFailedError) return 1;
  return 1;
}

const isAmbiguous = (err: unknown) => err instanceof VcsUsageError && /more than one thing/.test(err.message);

/** Splits compare's positionals into versions and paths (see the compare help text). */
async function splitCompare(repo: DesignRepo, positionals: string[]): Promise<{ versions: string[]; paths: string[] }> {
  const versions: string[] = [];
  const paths: string[] = [];
  for (const p of positionals) {
    if (paths.length > 0 || versions.length >= 2) {
      paths.push(p);
      continue;
    }
    try {
      await repo.resolveVersion(p);
      versions.push(p);
    } catch (err) {
      // An unknown #n is a mistyped version; any other unknown word is a file.
      if (!(err instanceof VcsUsageError) || isAmbiguous(err) || p.startsWith("#")) throw err;
      paths.push(p);
    }
  }
  return { versions, paths };
}

function historyLines(r: Awaited<ReturnType<DesignRepo["history"]>>): string[] {
  return r.versions.map((v) => `#${v.number}  ${v.shortId}  ${v.date}  ${v.message}`);
}

export async function runDesign(argv: string[], deps: DesignDeps): Promise<number> {
  const json = argv.includes("--json");
  const emitError = (message: string, code: number): number => {
    deps.stderr(`${message}\n`);
    if (json) deps.stdout(`${JSON.stringify({ error: message, code })}\n`);
    return code;
  };
  try {
    return await run(argv, deps, json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof VcsUsageError) return emitError(message, 2);
    if (err instanceof VcsRefusedError || err instanceof VcsCommitFailedError) return emitError(message, exitCodeOf(err));
    return emitError(`design: ${message}`, 1);
  }
}

async function run(argv: string[], deps: DesignDeps, json: boolean): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) throw new VcsUsageError('Say what to do, for example "design status". Run "design --help" to see the commands.');
  if (first === "--help" || first === "-h" || first === "help") {
    deps.stdout(MAIN_HELP);
    return 0;
  }
  if (!isCommand(first)) {
    throw new VcsUsageError(`"${first}" is not a design command. Run "design --help" to see the commands.`);
  }
  const name = first as Exclude<Command, "help">;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    throw new VcsUsageError(`${err instanceof Error ? err.message : String(err)}. Run "design ${name} --help" for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(commandHelp(name));
    return 0;
  }
  for (const key of Object.keys(values)) {
    if (["repo", "json", "help"].includes(key) || OWN[name]?.includes(key)) continue;
    throw new VcsUsageError(`"design ${name}" does not take --${key}. Run "design ${name} --help" for the options.`);
  }
  const rule = POSITIONALS[name];
  if (positionals.length < rule.min) throw new VcsUsageError(`"design ${name}" needs ${rule.what}. Run "design ${name} --help" for details.`);
  if (positionals.length > rule.max) throw new VcsUsageError(`"design ${name}" got too many arguments: ${positionals.join(" ")}.`);

  const dir = path.resolve(deps.cwd, values.repo ?? ".");
  const repo = (deps.createRepo ?? ((r) => createDesignRepo({ repo: r, ...(deps.clock && { clock: deps.clock }) })))(dir);
  const print = (result: { summary: string }, extra: string[] = []) => {
    deps.stdout(json ? `${JSON.stringify(result)}\n` : [result.summary, ...extra].map((l) => `${l}\n`).join(""));
  };

  switch (name) {
    case "init":
      print(await repo.init());
      break;
    case "status":
      print(await repo.status());
      break;
    case "save":
      print(await repo.save(values.message === undefined ? {} : { message: values.message }));
      break;
    case "history": {
      let limit: number | undefined;
      if (values.limit !== undefined) {
        if (!/^\d+$/.test(values.limit)) throw new VcsUsageError("The limit must be a whole number of 1 or more.");
        limit = Number(values.limit);
      }
      const r = await repo.history({ ...(positionals[0] !== undefined && { file: positionals[0] }), ...(limit !== undefined && { limit }) });
      print(r, historyLines(r));
      break;
    }
    case "compare": {
      const { versions, paths } = await splitCompare(repo, positionals);
      const options: CompareOptions = {
        ...(versions[0] !== undefined && { from: versions[0] }),
        ...(versions[1] !== undefined && { to: versions[1] }),
        paths,
        ...(values.out !== undefined && { out: path.resolve(deps.cwd, values.out) }),
        ...(values.open && { open: true }),
      };
      const cdeps: CompareDeps = {
        repo: dir,
        ...(deps.diff && { diff: deps.diff }),
        ...(deps.opener && { openFile: deps.opener }),
      };
      print(await (deps.compare ?? libCompare)(options, cdeps));
      break;
    }
    case "restore":
      print(
        await repo.restore({
          version: positionals[0],
          ...(positionals.length > 1 && { paths: positionals.slice(1) }),
          ...(values["save-first"] && { saveFirst: true }),
        }),
      );
      break;
    case "explore":
      print(await repo.explore(positionals[0] === undefined ? {} : { name: positionals[0] }));
      break;
    case "switch":
      print(await repo.switchTo(positionals[0]));
      break;
  }
  return 0;
}
