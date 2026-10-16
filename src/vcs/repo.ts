import { constants } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVcsExecFileGit, createSafeGit, type SafeGit } from "./git.js";
import type { GitExec } from "../git/exec.js";
import { classifyCommitFailure, VcsRefusedError, VcsUsageError } from "./errors.js";
import { guardNotRepo } from "./guard.js";
import { exploreOrList, switchExploration, type ExploreResult, type SwitchResult } from "./explore.js";
import { restoreVersion, type RestoreOptions, type RestoreResult } from "./restore.js";
import { COMMIT_LINE_FORMAT, LOG_FORMAT, parseCommitLines, parseLog } from "./log.js";
import { resolveRepoPath } from "./paths.js";
import { currentVersions, resolveVersion, type ResolvedVersion } from "./resolve.js";
import { getUnsavedChanges, type ChangedFile, type UnsavedChanges } from "./state.js";

export const REPORT_DIR_IGNORE = "/design-diff/";
export const FIRST_VERSION_MESSAGE = "First version";
const DEFAULT_NAME = "Designer";
const DEFAULT_EMAIL = "designer@localhost";

export interface DesignRepoOptions {
  repo: string;
  exec?: GitExec;
  /** Source of "now" for default save messages. */
  clock?: () => Date;
}

export interface SaveResult {
  saved: boolean;
  version: { sha: string; shortId: string } | null;
  message: string | null;
  files: ChangedFile[];
  summary: string;
}

export interface InitResult {
  /** True when a new repository was created. */
  createdRepo: boolean;
  gitignoreUpdated: boolean;
  identitySet: string[];
  saved: SaveResult | null;
  /** False when the run changed nothing. */
  changed: boolean;
  summary: string;
}

export interface StatusResult {
  exploration: string | null;
  files: ChangedFile[];
  clean: boolean;
  summary: string;
}

export interface HistoryVersion {
  /** Position in the whole history of the current exploration (#1 = latest); may have gaps when filtered. */
  number: number;
  sha: string;
  shortId: string;
  date: string;
  message: string;
  files: string[];
}

export interface HistoryResult {
  exploration: string | null;
  file: string | null;
  versions: HistoryVersion[];
  summary: string;
}

export interface DesignRepo {
  init(): Promise<InitResult>;
  status(): Promise<StatusResult>;
  save(options?: { message?: string }): Promise<SaveResult>;
  history(options?: { file?: string; limit?: number }): Promise<HistoryResult>;
  resolveVersion(ref: string): Promise<ResolvedVersion>;
  unsavedChanges(): Promise<UnsavedChanges>;
  restore(options: RestoreOptions): Promise<RestoreResult>;
  explore(options?: { name?: string }): Promise<ExploreResult>;
  switchTo(name: string): Promise<SwitchResult>;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function defaultSaveMessage(now: Date): string {
  return `Saved ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function describeFiles(files: ChangedFile[]): string {
  return files.map((f) => `${f.path} (${f.state})`).join(", ");
}

/** Paths to stage: only files git reported, so no pathspec ever fails to match. */
function addSpecsOf(files: ChangedFile[]): string[] {
  return [...new Set(files.map((f) => `:(literal)${f.path}`))];
}

/** Paths to commit: the staged files plus the old name of renames. */
function commitSpecsOf(files: ChangedFile[]): string[] {
  return [
    ...new Set(
      files.filter((f) => f.addedThenDeleted !== true).flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])).map((p) => `:(literal)${p}`),
    ),
  ];
}

export function createDesignRepo(options: DesignRepoOptions): DesignRepo {
  const { repo } = options;
  const clock = options.clock ?? (() => new Date());
  const git: SafeGit = createSafeGit(options.exec ?? createVcsExecFileGit(repo));

  const guarded: SafeGit = guardNotRepo(git);

  async function exploration(): Promise<string | null> {
    const name = (await guarded(["branch", "--show-current"])).trim();
    return name === "" ? null : name;
  }

  async function saveFiles(message: string, files: ChangedFile[]): Promise<SaveResult> {
    await guarded(["add", "--", ...addSpecsOf(files)]);
    const commitSpecs = commitSpecsOf(files);
    const committed = files.filter((f) => f.addedThenDeleted !== true);
    if (commitSpecs.length === 0) {
      return { saved: false, version: null, message: null, files: [], summary: "Nothing to save: no design changes since the last version." };
    }
    try {
      await git(["commit", `--message=${message}`, "--", ...commitSpecs]);
    } catch (err) {
      throw classifyCommitFailure(err);
    }
    const [head] = parseCommitLines(await git(["log", "--max-count=1", COMMIT_LINE_FORMAT]));
    return {
      saved: true,
      version: { sha: head.sha, shortId: head.shortId },
      message,
      files: committed,
      summary: `Saved a new version (${head.shortId}): ${message}. ${count(committed.length, "file")} included.`,
    };
  }

  async function save(opts: { message?: string } = {}): Promise<SaveResult> {
    const { files } = await getUnsavedChanges(guarded);
    if (files.length === 0) {
      return { saved: false, version: null, message: null, files: [], summary: "Nothing to save: no design changes since the last version." };
    }
    const message = opts.message !== undefined && opts.message.trim() !== "" ? opts.message : defaultSaveMessage(clock());
    return saveFiles(message, files);
  }

  async function ensureGitignore(root: string): Promise<boolean> {
    const file = path.join(root, ".gitignore");
    let current = "";
    try {
      if ((await lstat(file)).isSymbolicLink()) {
        throw new VcsRefusedError("The .gitignore in this folder is a link to another file, so it won't be changed. Replace it with a regular file first.");
      }
      current = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const wanted = new Set([REPORT_DIR_IGNORE, "/design-diff", "design-diff/", "design-diff"]);
    if (current.split(/\r?\n/).some((l) => wanted.has(l.trim()))) return false;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    try {
      await writeFile(file, `${current}${sep}${REPORT_DIR_IGNORE}\n`, {
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        throw new VcsRefusedError("The .gitignore in this folder is a link to another file, so it won't be changed. Replace it with a regular file first.");
      }
      throw err;
    }
    return true;
  }

  async function ensureIdentity(): Promise<string[]> {
    const set: string[] = [];
    for (const [key, value] of [["user.name", DEFAULT_NAME], ["user.email", DEFAULT_EMAIL]] as const) {
      let isSet = true;
      try {
        await git(["config", "--get", key]);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 1) throw err;
        isSet = false;
      }
      if (!isSet) {
        await git(["config", "--local", key, value]);
        set.push(key);
      }
    }
    return set;
  }

  async function init(): Promise<InitResult> {
    const root = await realpath(repo);
    let createdRepo = false;
    let top: string | undefined;
    try {
      top = (await git(["rev-parse", "--show-toplevel"])).trim();
    } catch {
      top = undefined;
    }
    if (top === undefined) {
      await git(["init", "--initial-branch=main"]);
      createdRepo = true;
    } else if ((await realpath(top)) !== root) {
      throw new VcsRefusedError("This folder is inside another project's history, so versions can't be started here. Open the design folder itself.");
    }

    const gitignoreUpdated = await ensureGitignore(root);
    const identitySet = await ensureIdentity();
    const { files } = await getUnsavedChanges(git);
    const result = files.length > 0 ? await saveFiles(FIRST_VERSION_MESSAGE, files) : null;
    const saved = result?.saved ? result : null;

    const changed = createdRepo || gitignoreUpdated || identitySet.length > 0 || saved !== null;
    const parts: string[] = [];
    if (createdRepo) parts.push("Started tracking versions in this folder.");
    if (gitignoreUpdated) parts.push("Report output (design-diff) is now left out of versions.");
    if (identitySet.length > 0) parts.push(`Set a local name/email for saving (${identitySet.join(", ")}).`);
    if (saved) parts.push(`Saved the existing designs as "${FIRST_VERSION_MESSAGE}" (${saved.version?.shortId}).`);
    const summary = changed ? parts.join(" ") : "Nothing changed: this folder is already set up for versions.";
    return { createdRepo, gitignoreUpdated, identitySet, saved, changed, summary };
  }

  async function status(): Promise<StatusResult> {
    const { files } = await getUnsavedChanges(guarded);
    const name = await exploration();
    const where = name === null ? "an earlier version" : `exploration "${name}"`;
    const summary =
      files.length === 0
        ? `No unsaved changes on ${where}.`
        : `${count(files.length, "unsaved change")} on ${where}: ${describeFiles(files)}.`;
    return { exploration: name, files, clean: files.length === 0, summary };
  }

  async function history(opts: { file?: string; limit?: number } = {}): Promise<HistoryResult> {
    const { limit } = opts;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new VcsUsageError("The limit must be a whole number of 1 or more.");
    }
    const file = opts.file === undefined ? null : await resolveRepoPath(repo, opts.file);
    const name = await exploration();
    const all = await currentVersions(guarded);
    const numberOf = new Map(all.map((c, i) => [c.sha, i + 1]));
    const range = limit === undefined ? [] : [`--max-count=${limit}`];
    let versions: HistoryVersion[] = [];
    if (all.length > 0) {
      const target = file === null ? [] : ["--follow", "--", file];
      const out = await guarded(["log", "-z", "--name-only", ...range, LOG_FORMAT, ...target]);
      versions = parseLog(out).map((e) => ({ number: numberOf.get(e.sha) ?? 0, ...e }));
    }
    const subject = file === null ? "" : ` for ${file}`;
    const summary = versions.length === 0 ? `No saved versions${subject} yet.` : `${count(versions.length, "saved version")}${subject}, newest first.`;
    return { exploration: name, file, versions, summary };
  }

  return {
    init,
    status,
    save,
    history,
    resolveVersion: (ref) => resolveVersion(guarded, ref),
    unsavedChanges: () => getUnsavedChanges(guarded),
    restore: (opts) => restoreVersion({ git: guarded, repo, save: (message) => save({ message }) }, opts),
    explore: (opts = {}) => exploreOrList(guarded, opts.name),
    switchTo: (name) => switchExploration(guarded, name),
  };
}
