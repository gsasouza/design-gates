import { execFile } from "node:child_process";
import { gitExecOptions, type GitExec } from "../git/exec.js";
import { VcsUsageError } from "./errors.js";

/** Every git subcommand src/vcs may issue. Adding one is a deliberate act (a test pins this list). */
export const ALLOWED_GIT_SUBCOMMANDS = [
  "init",
  "rev-parse",
  "config",
  "status",
  "add",
  "commit",
  "log",
  "diff",
  "ls-files",
  "show",
  "branch",
  "for-each-ref",
  "restore",
  "switch",
] as const;

export type AllowedGitSubcommand = (typeof ALLOWED_GIT_SUBCOMMANDS)[number];

export const FORBIDDEN_GIT_SUBCOMMANDS = ["push", "clean", "reset", "rebase", "checkout"] as const;

const FORBIDDEN_FLAGS = ["--global", "--system", "--force", "-f", "-D", "--hard"];
const FORBIDDEN_BRANCH_FLAGS = ["--delete", "-d"];
const FORBIDDEN_CONFIG_FLAGS = ["--file", "--blob", "--worktree", "--edit", "-e"];

/** Runs a vcs git call; args start with the subcommand. */
export type SafeGit = (args: string[]) => Promise<string>;

/** Rejects with git's stderr on the error, so failures can be explained in plain language. */
export function createVcsExecFileGit(repo: string, env: NodeJS.ProcessEnv = {}): GitExec {
  const base = gitExecOptions(repo);
  const options = { ...base, env: { ...base.env, LC_ALL: "C", ...env } };
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, options, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(stdout);
      });
    });
}

function optionArgs(args: string[]): string[] {
  const end = args.findIndex((a) => a === "--" || a === "--end-of-options");
  return end === -1 ? args : args.slice(0, end);
}

/** Throws before anything runs unless `args` is an allowed subcommand without forbidden flags. */
export function assertSafeGitArgs(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === undefined) throw new Error("git call refused: no subcommand");
  if ((FORBIDDEN_GIT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(`git call refused: '${sub}' is never allowed`);
  }
  if (!(ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(`git call refused: '${sub}' is not an allowed subcommand`);
  }
  const options = optionArgs(rest);
  const forbidden = [
    ...FORBIDDEN_FLAGS,
    ...(sub === "branch" ? FORBIDDEN_BRANCH_FLAGS : []),
    ...(sub === "config" ? FORBIDDEN_CONFIG_FLAGS : []),
  ];
  for (const arg of options) {
    if (forbidden.includes(arg) || arg.startsWith("--file=")) {
      throw new Error(`git call refused: '${arg}' is never allowed`);
    }
    // Clustered short flags such as -fd or -Df.
    if (/^-[a-zA-Z]{2,}$/.test(arg) && /[fD]/.test(arg)) {
      throw new Error(`git call refused: '${arg}' is never allowed`);
    }
  }
  if (sub === "config" && !options.includes("--local") && !options.includes("--get")) {
    throw new Error("git call refused: config may only read or write repo-local values");
  }
}

export function createSafeGit(exec: GitExec): SafeGit {
  return async (args) => {
    assertSafeGitArgs(args);
    return exec(["--no-optional-locks", ...args]);
  };
}

/** A user-supplied path or ref must not look like an option. */
export function assertNotOption(value: string, what: string): void {
  if (value.startsWith("-")) throw new VcsUsageError(`That ${what} can't start with a dash: ${value}`);
}
