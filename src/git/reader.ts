/** Marker for "diff against the working tree" instead of a committed ref. */
export const WORKTREE = Symbol("worktree");
export type Worktree = typeof WORKTREE;

export type ChangeStatus = "added" | "removed" | "modified" | "renamed";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
}

/** Thrown when a user supplied ref is malformed or does not resolve to a commit. */
export class InvalidRefError extends Error {
  readonly ref: string;
  constructor(ref: string, reason: string) {
    super(`Invalid git ref "${ref}": ${reason}`);
    this.name = "InvalidRefError";
    this.ref = ref;
  }
}

export interface GitReader {
  mergeBase(a: string, b: string): Promise<string>;
  listChangedPenFiles(base: string, head: string | Worktree, globs: string[]): Promise<ChangedFile[]>;
  readBlob(ref: string, path: string): Promise<string>;
  readWorktree(path: string): Promise<string>;
  /** Sorted repo-relative paths of tracked and untracked (not ignored) .pen files matching `globs` (default: all). */
  listPenFiles?(globs: string[]): Promise<string[]>;
}

/** Default diff base: the merge base of `main` and HEAD. */
export function defaultBase(reader: GitReader): Promise<string> {
  return reader.mergeBase("main", "HEAD");
}
