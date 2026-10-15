import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type ChangedFile,
  type ChangeStatus,
  type GitReader,
  InvalidRefError,
  WORKTREE,
  type Worktree,
} from "./reader.js";

/** Runs git with the given args (already including `--no-optional-locks`) and returns stdout. */
export type GitExec = (args: string[]) => Promise<string>;

export const MAX_BUFFER = 256 * 1024 * 1024;

export function gitExecOptions(cwd: string) {
  return {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_BUFFER,
    encoding: "utf8" as const,
    shell: false,
  };
}

export function createExecFileGit(repo: string): GitExec {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, gitExecOptions(repo), (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
}

export function buildPathspecs(globs: string[]): string[] {
  if (globs.length === 0) return [":(glob)**/*.pen"];
  return globs.map((g) => `:(glob)${g}`);
}

/** User globs narrow the result, so non-.pen matches are dropped (path and oldPath). */
function onlyPen(files: ChangedFile[]): ChangedFile[] {
  return files.filter((f) => f.path.endsWith(".pen") && (f.oldPath === undefined || f.oldPath.endsWith(".pen")));
}

/** Parses `git diff --name-status -z` output, including two-path renames/copies. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (kind === "R") files.push({ path: newPath, oldPath, status: "renamed" });
      else files.push({ path: newPath, status: "added" });
      continue;
    }
    const file = parts[i++];
    const status: ChangeStatus = kind === "A" ? "added" : kind === "D" ? "removed" : "modified";
    files.push({ path: file, status });
  }
  return files;
}

function parseNul(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

export function createGitReader(repo: string, exec: GitExec = createExecFileGit(repo)): GitReader {
  const git = (...args: string[]) => exec(["--no-optional-locks", ...args]);

  async function resolve(ref: string): Promise<string> {
    if (ref.startsWith("-")) throw new InvalidRefError(ref, "must not start with '-'");
    try {
      return (await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).trim();
    } catch {
      throw new InvalidRefError(ref, "does not resolve to a commit");
    }
  }

  return {
    async mergeBase(a, b) {
      const [ra, rb] = [await resolve(a), await resolve(b)];
      return (await git("merge-base", ra, rb)).trim();
    },

    async listChangedPenFiles(base, head: string | Worktree, globs) {
      const specs = buildPathspecs(globs);
      const rb = await resolve(base);
      if (head !== WORKTREE) {
        const rh = await resolve(head);
        return onlyPen(parseNameStatus(await git("diff", "--name-status", "-M", "-z", rb, rh, "--", ...specs)));
      }
      const tracked = onlyPen(parseNameStatus(await git("diff", "--name-status", "-M", "-z", rb, "--", ...specs)));
      const seen = new Set(tracked.map((f) => f.path));
      const untracked = parseNul(
        await git("ls-files", "--others", "--exclude-standard", "-z", "--", ...specs),
      );
      for (const p of untracked) {
        if (p.endsWith(".pen") && !seen.has(p)) tracked.push({ path: p, status: "added" });
      }
      return tracked;
    },

    async readBlob(ref, filePath) {
      const rr = await resolve(ref);
      return git("show", `${rr}:${filePath}`);
    },

    async readWorktree(filePath) {
      const root = await realpath(repo);
      const target = path.resolve(root, filePath);
      const rel = path.relative(root, target);
      if (rel === "" || (rel === ".." || rel.startsWith(".." + path.sep)) || path.isAbsolute(rel)) {
        throw new Error(`Path escapes the repository: ${filePath}`);
      }
      // Resolve symlinks so a link inside the repo cannot point outside it.
      const real = await realpath(target);
      const realRel = path.relative(root, real);
      if ((realRel === ".." || realRel.startsWith(".." + path.sep)) || path.isAbsolute(realRel)) {
        throw new Error(`Path escapes the repository: ${filePath}`);
      }
      return readFile(real, "utf8");
    },
  };
}
