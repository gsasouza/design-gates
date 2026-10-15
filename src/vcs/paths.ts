import { realpath } from "node:fs/promises";
import path from "node:path";
import { VcsUsageError } from "./errors.js";

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/** Realpath of the nearest ancestor that exists, re-joined with the missing tail (the file may be deleted). */
async function realpathLoose(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a user path against the realpath of the repo root and returns it relative to the root
 * with forward slashes. Anything outside the root (also through symlinks) is a usage error.
 */
export async function resolveRepoPath(repo: string, userPath: string): Promise<string> {
  if (userPath === "") throw new VcsUsageError("Say which file you mean.");
  if (userPath.startsWith("-")) throw new VcsUsageError(`A file name can't start with a dash: ${userPath}`);
  const root = await realpath(repo);
  const target = path.resolve(root, userPath);
  const outside = new VcsUsageError(`That file is outside this design folder: ${userPath}`);
  const rel = path.relative(root, target);
  if (rel === "" || escapes(rel)) throw outside;
  const realRel = path.relative(root, await realpathLoose(target));
  if (realRel === "" || escapes(realRel)) throw outside;
  return rel.split(path.sep).join("/");
}
