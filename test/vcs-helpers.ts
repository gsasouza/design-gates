import type { GitExec } from "../src/git/exec.js";

export interface Recorder {
  calls: string[][];
  exec: GitExec;
  subcommands(): string[];
}

/** A fake GitExec: records argv and answers via `handler(args-without---no-optional-locks)`. */
export function recordingGit(handler: (args: string[]) => string | Error | undefined): Recorder {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push(args);
    const result = handler(args.slice(1));
    if (result instanceof Error) throw result;
    return result ?? "";
  };
  return { calls, exec, subcommands: () => calls.map((c) => c[1]) };
}

export function gitError(stderr: string, code = 1): Error {
  return Object.assign(new Error(`Command failed: git\n${stderr}`), { stderr, code });
}

/** Output of `git status --porcelain=v1 -z`. */
export const porcelain = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");
