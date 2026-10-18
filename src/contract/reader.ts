import type { GitReader } from "../git/reader.js";

/** The only way rules' inputs read repo files outside the .pen documents; tests pass an in-memory fake. Paths are repo-relative POSIX. */
export interface ContractReader {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Sorted tracked and untracked (not ignored) files matching the globs; no globs gives none. */
  listFiles(globs: string[]): Promise<string[]>;
}

const NOT_A_FILE = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** The production reader: worktree reads and file listing through the (repo-confined) git reader. */
export function createGitContractReader(git: GitReader): ContractReader {
  return {
    readFile: (path) => git.readWorktree(path),
    async exists(path) {
      try {
        await git.readWorktree(path);
        return true;
      } catch (err) {
        if (NOT_A_FILE.has((err as { code?: string } | null)?.code ?? "")) return false;
        throw err;
      }
    },
    async listFiles(globs) {
      if (globs.length === 0) return [];
      if (!git.listFiles) throw new Error("git reader cannot list files");
      return git.listFiles(globs);
    },
  };
}
