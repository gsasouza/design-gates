import type { SafeGit } from "./git.js";

/** Only .pen files and files under a top-level `assets/` directory are versioned. */
export const DESIGN_PATHSPECS = [":(glob)**/*.pen", ":(glob)assets/**"];

export function isDesignPath(p: string): boolean {
  return p.endsWith(".pen") || p.startsWith("assets/");
}

export type FileState = "new" | "changed" | "deleted";

export interface ChangedFile {
  path: string;
  state: FileState;
  /** Set when the file was renamed. */
  oldPath?: string;
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parseStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    let oldPath: string | undefined;
    if (x === "R" || x === "C") oldPath = parts[++i];
    let state: FileState = "changed";
    if (x === "?") state = "new";
    else if (x === "R" || x === "C") state = "changed";
    else if (x === "A") state = y === "D" ? "deleted" : "new";
    else if (x === "D" || y === "D") state = "deleted";
    if (!isDesignPath(file)) continue;
    files.push(oldPath === undefined ? { path: file, state } : { path: file, state, oldPath });
  }
  return files;
}

export interface UnsavedChanges {
  unsaved: boolean;
  files: ChangedFile[];
}

/**
 * The working folder has unsaved changes when a tracked .pen or assets/ file is modified, staged or
 * deleted, or when an untracked (not ignored) .pen file or file under assets/ exists.
 */
export async function getUnsavedChanges(git: SafeGit): Promise<UnsavedChanges> {
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...DESIGN_PATHSPECS]);
  const files = parseStatus(out);
  return { unsaved: files.length > 0, files };
}
