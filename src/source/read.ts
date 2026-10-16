import { type GitReader, WORKTREE, type Worktree } from "../git/reader.js";
import { designFormatOf } from "./format.js";
import { loadDesignSource } from "./load.js";
import type { DesignSource } from "./types.js";

/** Reads `file` at `ref` (or the worktree) and loads it; `.fig` goes through the byte reads, `.pen` through the text reads. */
export async function readDesignSource(git: GitReader, ref: string | Worktree, file: string): Promise<DesignSource> {
  if (designFormatOf(file) === "fig") {
    return loadDesignSource(file, ref === WORKTREE ? await git.readWorktreeBytes(file) : await git.readBlobBytes(ref, file));
  }
  return loadDesignSource(file, ref === WORKTREE ? await git.readWorktree(file) : await git.readBlob(ref, file));
}
