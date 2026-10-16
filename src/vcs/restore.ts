import { VcsRefusedError } from "./errors.js";
import type { SafeGit } from "./git.js";
import { resolveRepoPath } from "./paths.js";
import { resolveVersion, type ResolvedVersion } from "./resolve.js";
import type { SaveResult } from "./repo.js";
import { DESIGN_PATHSPECS, getUnsavedChanges, isDesignPath, type ChangedFile } from "./state.js";

export interface RestoreOptions {
  version: string;
  paths?: string[];
  /** Save unsaved changes first instead of refusing. */
  saveFirst?: boolean;
}

export interface RestoreResult {
  /** True when files in the folder actually changed. */
  restored: boolean;
  version: ResolvedVersion;
  /** Files that now differ from the last saved version (unsaved changes). */
  files: ChangedFile[];
  savedFirst: SaveResult | null;
  summary: string;
}

export interface RestoreDeps {
  git: SafeGit;
  repo: string;
  save: (message: string) => Promise<SaveResult>;
}

const PEN_SPEC = ":(glob)**/*.pen";
const FIG_SPEC = ":(glob)**/*.fig";
const ASSETS_SPEC = "assets/";

/** The user's own reference as a label: `3` and `#3` both read `#3`. */
function labelOf(ref: string): string {
  const r = ref.trim();
  return /^\d+$/.test(r) ? `#${r}` : r;
}

/** Files that exist in `sha` or are tracked now (the index merged with that tree). */
function filesIn(git: SafeGit, sha: string, specs: string[]): Promise<string[]> {
  return git(["ls-files", "-z", `--with-tree=${sha}`, "--", ...specs]).then((out) => out.split("\0").filter((p) => p !== ""));
}

async function pathspecsFor(deps: RestoreDeps, sha: string, userPaths: string[] | undefined): Promise<string[]> {
  const nothing = new VcsRefusedError("There is nothing to restore: no matching design files exist in that version or in this folder.");
  if (userPaths === undefined || userPaths.length === 0) {
    const found = await filesIn(deps.git, sha, DESIGN_PATHSPECS);
    const specs = [
      ...(found.some((p) => p.endsWith(".pen")) ? [PEN_SPEC] : []),
      ...(found.some((p) => p.endsWith(".fig")) ? [FIG_SPEC] : []),
      ...(found.some((p) => p.startsWith("assets/")) ? [ASSETS_SPEC] : []),
    ];
    if (specs.length === 0) throw nothing;
    return specs;
  }
  const specs: string[] = [];
  for (const user of userPaths) {
    const rel = await resolveRepoPath(deps.repo, user);
    const spec = `:(literal)${rel}`;
    if ((await filesIn(deps.git, sha, [spec])).length === 0) {
      throw new VcsRefusedError(`There is nothing to restore for ${rel}: it isn't in that version and isn't saved in this folder.`);
    }
    specs.push(spec);
  }
  return specs;
}

/** Changed files under the user's own pathspecs that are not designs, so a save would not keep them. */
async function otherUnsaved(git: SafeGit, specs: string[]): Promise<string[]> {
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...specs]);
  const parts = out.split("\0");
  const found: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    if (entry[0] === "R" || entry[0] === "C") i++;
    const file = entry.slice(3);
    if (!isDesignPath(file)) found.push(file);
  }
  return found;
}

/**
 * Brings files back as they were in a version, as unsaved changes. History is never touched:
 * only `git restore --worktree` runs, never a commit (except the optional save-first) or a ref move.
 */
export async function restoreVersion(deps: RestoreDeps, options: RestoreOptions): Promise<RestoreResult> {
  const { git } = deps;
  const version = await resolveVersion(git, options.version);
  const label = labelOf(options.version);

  const specs = await pathspecsFor(deps, version.sha, options.paths);
  if (options.paths !== undefined && options.paths.length > 0) {
    const others = await otherUnsaved(git, specs);
    if (others.length > 0) {
      throw new VcsRefusedError(
        `${others.join(", ")} ${others.length === 1 ? "has" : "have"} unsaved changes that are not design files, and restoring would overwrite ${others.length === 1 ? "it" : "them"}. Move or commit ${others.length === 1 ? "it" : "them"} first.`,
      );
    }
  }

  const unsaved = await getUnsavedChanges(git);
  let savedFirst: SaveResult | null = null;
  if (unsaved.unsaved) {
    if (options.saveFirst !== true) {
      throw new VcsRefusedError(
        `You have ${unsaved.files.length} unsaved ${unsaved.files.length === 1 ? "change" : "changes"}, and restoring would mix them with the old version. Run design save first, or use --save-first.`,
      );
    }
    savedFirst = await deps.save(`Before restore to ${label}`);
  }

  await git(["restore", `--source=${version.sha}`, "--worktree", "--", ...specs]);

  const { files } = await getUnsavedChanges(git);
  const saved = savedFirst?.version ? ` Your earlier changes were saved first (${savedFirst.version.shortId}).` : "";
  if (files.length === 0) {
    return { restored: false, version, files, savedFirst, summary: `Nothing changed: the files already match ${label}.${saved}` };
  }
  return {
    restored: true,
    version,
    files,
    savedFirst,
    summary: `Brought back ${label} as ${files.length} unsaved ${files.length === 1 ? "change" : "changes"}. Nothing was lost: run design save to keep it as a new version.${saved}`,
  };
}
