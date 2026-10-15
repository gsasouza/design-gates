import { execFile } from "node:child_process";
import path from "node:path";
import { buildDiffReport, defaultDeps, UsageError, type DiffDeps, type DiffOptions } from "../cli/run-diff.js";
import type { DiffResult } from "../diff/model.js";
import { createGitReader, type GitExec } from "../git/exec.js";
import { VcsRefusedError, VcsUsageError } from "./errors.js";
import { createSafeGit, createVcsExecFileGit, type SafeGit } from "./git.js";
import { guardNotRepo } from "./guard.js";
import { resolveRepoPath } from "./paths.js";
import { resolveVersion, type ResolvedVersion } from "./resolve.js";

export interface CompareOptions {
  /** Version to compare from; defaults to the last saved version (#1). */
  from?: string;
  /** Version to compare to; defaults to the unsaved working files. */
  to?: string;
  paths?: string[];
  out?: string;
  open?: boolean;
}

export interface CompareResult {
  files: number;
  frames: number;
  changes: number;
  reportPath: string;
  from: ResolvedVersion;
  /** Null when comparing to the unsaved working files. */
  to: ResolvedVersion | null;
  summary: string;
}

export interface CompareDeps {
  repo: string;
  exec?: GitExec;
  /** Renderer and file system seams; `git` and `gitDirs` are always supplied by compare itself. */
  diff?: DiffDeps;
  buildDiffReport?: (options: DiffOptions, deps: DiffDeps) => Promise<{ result: DiffResult; out: string }>;
  openFile?: (file: string) => Promise<void>;
}

/** Picks the platform's opener; args are passed verbatim, never through a shell. */
export function openerFor(platform: string, file: string): [string, string[]] {
  if (platform === "darwin") return ["open", [file]];
  // explorer.exe takes the path as one argument; cmd.exe would re-parse &, ^ and |.
  if (platform === "win32") return ["explorer.exe", [file]];
  return ["xdg-open", [file]];
}

/** Opens a file with the system viewer; no shell is involved. */
export function defaultOpenFile(file: string): Promise<void> {
  const [cmd, args] = openerFor(process.platform, file);
  const ignoreExitCode = process.platform === "win32"; // explorer.exe exits non-zero even on success
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { shell: false }, (err) => (err && !(ignoreExitCode && typeof err.code === "number") ? reject(err) : resolve()));
  });
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function friendly(err: unknown): unknown {
  if (err instanceof UsageError) return new VcsUsageError(err.message);
  if (err instanceof Error && /^Not a git repository/.test(err.message)) {
    return new VcsRefusedError("This folder doesn't have versions yet. Run init to start saving versions.");
  }
  if (err instanceof Error && /^Refusing to write/.test(err.message)) {
    return new VcsRefusedError(`The report can't be written there: ${err.message.replace(/^Refusing to write/, "refusing to write")}. Choose another output folder.`);
  }
  return err;
}

export async function compare(options: CompareOptions, deps: CompareDeps): Promise<CompareResult> {
  const repo = path.resolve(deps.repo);
  const raw: SafeGit = createSafeGit(deps.exec ?? createVcsExecFileGit(repo));
  const git = guardNotRepo(raw);
  const base = deps.diff ?? defaultDeps();

  const from = await resolveVersion(git, options.from ?? "#1");
  const to = options.to === undefined ? null : await resolveVersion(git, options.to);
  const paths: string[] = [];
  for (const p of options.paths ?? []) paths.push(await resolveRepoPath(repo, p));

  // The reader and run-diff both prefix `--no-optional-locks`; the safe wrapper adds it itself.
  const readerExec: GitExec = (args) => git(args[0] === "--no-optional-locks" ? args.slice(1) : args);
  const abs = async (args: string[]) => path.resolve(repo, (await git(args)).trim());
  const diffDeps: DiffDeps = {
    ...base,
    git: createGitReader(repo, readerExec),
    gitDirs: async () => [await abs(["rev-parse", "--absolute-git-dir"]), await abs(["rev-parse", "--path-format=absolute", "--git-common-dir"])],
  };
  const out = options.out === undefined ? path.join(repo, "design-diff") : path.resolve(base.cwd, options.out);
  const diffOptions: DiffOptions = { repo, base: from.sha, ...(to && { head: to.sha }), out, paths };

  let report: { result: DiffResult; out: string };
  try {
    report = await (deps.buildDiffReport ?? buildDiffReport)(diffOptions, diffDeps);
  } catch (err) {
    throw friendly(err);
  }
  const frames = report.result.files.flatMap((f) => f.frames);
  const changes = frames.reduce((n, f) => n + f.nodes.length, 0);
  const reportPath = path.join(report.out, "report.html");
  if (options.open === true) await (deps.openFile ?? defaultOpenFile)(reportPath);
  return {
    files: report.result.files.length,
    frames: frames.length,
    changes,
    reportPath,
    from,
    to,
    summary: `${plural(changes, "change")} in ${plural(frames.length, "frame")} — report: ${reportPath}`,
  };
}
