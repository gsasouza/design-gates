import path from "node:path";
import { BASELINE_FILE, entryOf, fingerprint, parseBaseline, serializeBaseline } from "../check/baseline.js";
import { FORMATS, formatAgent, formatSarif, formatText, type Format, type Reported } from "../check/format.js";
import { applySuppressions, collectSuppressions } from "../check/suppress.js";
import { compile } from "../compile/compile.js";
import { diffVariables } from "../diff/variables.js";
import { resolveConfig, type GatesConfig } from "../gates/config.js";
import type { DiffContext, Violation } from "../gates/types.js";
import { createGitReader } from "../git/exec.js";
import { InvalidRefError, type GitReader } from "../git/reader.js";
import { parsePen } from "../pen/load.js";
import type { PenDocument } from "../pen/types.js";
import { parseFailureViolation } from "../rules/parse-failure.js";
import { registry, runRules, type RuleEntry, type RuleInput } from "../rules/index.js";
import { defaultFs, UsageError, type RunFs } from "./run-diff.js";

export const CONFIG_FILE = "design-gates.config.json";

export interface CheckOptions {
  paths?: string[];
  base?: string;
  format?: string;
  config?: string;
  updateBaseline?: boolean;
  scope?: string[];
}

export interface CheckDeps {
  /** The repository root. */
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  git?: GitReader;
  /** Only writes go through this seam; reads are confined to the repo by the git reader. */
  fs: Pick<RunFs, "writeFile" | "isSymlink">;
  /** Rules to run; defaults to the registry. */
  entries?: readonly RuleEntry[];
}

export function defaultCheckDeps(): CheckDeps {
  return {
    cwd: process.cwd(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    fs: defaultFs,
  };
}

const isMissing = (err: unknown): boolean => (err as { code?: string } | null)?.code === "ENOENT";

/** Repo-relative POSIX form of a user path; refuses anything outside the repo. */
function repoRelative(root: string, input: string, what: string): string {
  const rel = path.relative(root, path.resolve(root, input));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UsageError(`${what} must be inside the repository, got "${input}"`);
  }
  return rel.split(path.sep).join("/");
}

function validate(o: CheckOptions): Format {
  const format = o.format ?? "agent";
  if (!(FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}, got "${format}"`);
  if (o.base !== undefined && (o.base === "" || o.base.startsWith("-"))) throw new UsageError(`--base must be a git ref, got "${o.base}"`);
  return format as Format;
}

async function loadConfig(git: GitReader, root: string, o: CheckOptions): Promise<GatesConfig> {
  const file = o.config !== undefined ? repoRelative(root, o.config, "--config") : CONFIG_FILE;
  let text: string;
  try {
    text = await git.readWorktree(file);
  } catch (err) {
    if (o.config === undefined && isMissing(err)) text = "null";
    else throw new UsageError(`cannot read config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const result = resolveConfig(raw);
  if ("error" in result) throw new UsageError(`invalid config ${file}: ${result.error}`);
  result.config.rules["DIF-001"].scope.push(...(o.scope ?? []));
  return result.config;
}

/** Head and (with --base) base documents of one file; `error` is set when the head cannot be parsed, undefined when it is gone. */
type Loaded = { error: Violation } | { head: PenDocument; baseDoc: PenDocument | undefined };

async function loadFile(git: GitReader, file: string, base: string | undefined): Promise<Loaded | undefined> {
  let head: PenDocument;
  try {
    head = parsePen(await git.readWorktree(file));
  } catch (err) {
    return isMissing(err) ? undefined : { error: parseFailureViolation(file, err) };
  }
  let baseDoc: PenDocument | undefined;
  if (base !== undefined) {
    try {
      baseDoc = parsePen(await git.readBlob(base, file));
    } catch {
      baseDoc = undefined; // added since base, or unreadable there
    }
  }
  return { head, baseDoc };
}

/** Block/warn overrides of `rules.SCH-001` also apply to the violations the CLI itself raises for it. */
function withSchSeverity(v: Violation, config: GatesConfig): Violation {
  const override = config.rules["SCH-001"].severity;
  return override === "block" || override === "warn" ? { ...v, severity: override } : v;
}

async function build(o: CheckOptions, deps: CheckDeps): Promise<number> {
  const format = validate(o);
  const root = deps.cwd;
  const git = deps.git ?? createGitReader(root);
  const entries = deps.entries ?? registry;
  const config = await loadConfig(git, root, o);

  const globs = (o.paths ?? []).map((p) => repoRelative(root, p, "path"));
  if (o.base !== undefined) {
    try {
      await git.mergeBase(o.base, o.base);
    } catch (err) {
      if (err instanceof InvalidRefError) throw new UsageError(err.message);
      throw err;
    }
  }
  if (!git.listPenFiles) throw new Error("git reader cannot list .pen files");
  const files = await git.listPenFiles(globs);

  // `off` on SCH-001 also silences the file-level parse failures and suppression problems the CLI raises for it.
  const sch001Off = config.rules["SCH-001"].severity === "off";
  const inputs: RuleInput[] = [];
  const cliViolations: Violation[] = [];
  const suppressions = new Map<string, ReturnType<typeof collectSuppressions>>();
  for (const file of files) {
    const loaded = await loadFile(git, file, o.base);
    if (!loaded) continue;
    if ("error" in loaded) {
      if (!sch001Off) cliViolations.push(withSchSeverity(loaded.error, config));
      continue;
    }
    const compiled = compile(loaded.head, { file });
    const input: RuleInput = { file, compiled };
    if (o.base !== undefined) {
      const diff: DiffContext = {
        head: compiled,
        variables: diffVariables({ [file]: { head: loaded.head, ...(loaded.baseDoc && { base: loaded.baseDoc }) } }),
        ...(loaded.baseDoc && { base: compile(loaded.baseDoc, { file }) }),
      };
      input.diff = diff;
    }
    inputs.push(input);
    const sup = collectSuppressions(compiled, file);
    suppressions.set(file, sup);
    if (!sch001Off) cliViolations.push(...sup.invalid.map((v) => withSchSeverity(v, config)));
  }

  const ruleViolations = runRules(inputs, config, entries);
  const violations: Violation[] = [...cliViolations];
  for (const input of inputs) {
    const own = ruleViolations.filter((v) => v.file === input.file);
    violations.push(...applySuppressions(own, input.compiled, suppressions.get(input.file)!.byNode));
  }

  let known = new Set<string>();
  try {
    known = parseBaseline(await git.readWorktree(BASELINE_FILE));
  } catch (err) {
    if (!isMissing(err)) throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (o.updateBaseline) {
    const target = path.join(root, BASELINE_FILE);
    if (await deps.fs.isSymlink(target)) throw new Error(`Refusing to write through a symlink: ${target}`);
    await deps.fs.writeFile(target, serializeBaseline(violations));
    known = new Set(violations.map((v) => fingerprint(entryOf(v))));
  }
  const reported: Reported[] = violations.map((v) => (known.has(fingerprint(entryOf(v))) ? { ...v, baselined: true } : v));

  deps.stdout(format === "agent" ? formatAgent(reported) : format === "sarif" ? formatSarif(reported, entries) : formatText(reported));
  return reported.some((v) => v.severity === "block" && !v.baselined) ? 1 : 0;
}

/** Runs `design-gates check`; resolves to the exit code: 0 clean, 1 a block violation remains, 2 usage/config/other error. */
export async function runCheck(options: CheckOptions, deps: CheckDeps = defaultCheckDeps()): Promise<number> {
  try {
    return await build(options, deps);
  } catch (err) {
    deps.stderr(`design-gates: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
