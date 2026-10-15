import { stderrOf, VcsRefusedError } from "./errors.js";
import type { SafeGit } from "./git.js";

/** Wraps `git` so "not a repository" becomes a friendly refusal. */
export function guardNotRepo(git: SafeGit): SafeGit {
  return async (args) => {
    try {
      return await git(args);
    } catch (err) {
      if (/not a git repository/i.test(stderrOf(err))) {
        throw new VcsRefusedError("This folder doesn't have versions yet. Run init to start saving versions.");
      }
      throw err;
    }
  };
}
