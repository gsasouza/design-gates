import { VcsRefusedError, VcsUsageError } from "./errors.js";
import type { SafeGit } from "./git.js";
import { getUnsavedChanges } from "./state.js";

export interface Exploration {
  name: string;
  current: boolean;
}

export interface ExploreResult {
  /** True when a new exploration was started. */
  created: boolean;
  /** The exploration now in use (null on an earlier version). */
  exploration: string | null;
  explorations: Exploration[];
  summary: string;
}

export interface SwitchResult {
  exploration: string;
  /** False when that exploration was already in use. */
  switched: boolean;
  summary: string;
}

async function listExplorations(git: SafeGit): Promise<string[]> {
  const out = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return out.split("\n").filter((n) => n !== "");
}

async function currentExploration(git: SafeGit): Promise<string | null> {
  const name = (await git(["branch", "--show-current"])).trim();
  return name === "" ? null : name;
}

async function refuseIfUnsaved(git: SafeGit, action: string): Promise<void> {
  const { files } = await getUnsavedChanges(git);
  if (files.length > 0) {
    throw new VcsRefusedError(
      `You have ${files.length} unsaved ${files.length === 1 ? "change" : "changes"}, so you can't ${action} yet. Run design save first.`,
    );
  }
}

async function assertValidName(git: SafeGit, name: string): Promise<void> {
  if (name.trim() === "") throw new VcsUsageError("Give the exploration a name.");
  if (name.startsWith("-")) throw new VcsUsageError(`An exploration name can't start with a dash: ${name}`);
  const bad = new VcsUsageError(`"${name}" can't be used as an exploration name. Use letters, numbers, dashes and slashes, without spaces.`);
  if (name === "HEAD" || name.includes("@{")) throw bad;
  try {
    await git(["check-ref-format", "--branch", name]);
  } catch {
    throw bad;
  }
}

/** With a name: starts an exploration from the current version and switches to it. Without: lists explorations. */
export async function exploreOrList(git: SafeGit, name?: string): Promise<ExploreResult> {
  if (name === undefined) {
    const [names, current] = [await listExplorations(git), await currentExploration(git)];
    const explorations = names.map((n) => ({ name: n, current: n === current }));
    const summary =
      explorations.length === 0
        ? "No explorations yet."
        : `${explorations.length} ${explorations.length === 1 ? "exploration" : "explorations"}: ${explorations.map((e) => (e.current ? `${e.name} (current)` : e.name)).join(", ")}.`;
    return { created: false, exploration: current, explorations, summary };
  }
  await assertValidName(git, name);
  if ((await listExplorations(git)).includes(name)) {
    throw new VcsUsageError(`There is already an exploration called "${name}". Pick another name, or switch to it.`);
  }
  await refuseIfUnsaved(git, "start an exploration");
  await git(["switch", "-c", name]);
  const explorations = (await listExplorations(git)).map((n) => ({ name: n, current: n === name }));
  return { created: true, exploration: name, explorations, summary: `Started exploration "${name}" from the current version and switched to it.` };
}

/** Switches to an existing exploration (or `main`). */
export async function switchExploration(git: SafeGit, name: string): Promise<SwitchResult> {
  if (name.trim() === "") throw new VcsUsageError("Say which exploration to switch to.");
  if (name.startsWith("-")) throw new VcsUsageError(`An exploration name can't start with a dash: ${name}`);
  const names = await listExplorations(git);
  if (!names.includes(name)) {
    const known = names.length === 0 ? "There are no explorations yet." : `Existing explorations: ${names.join(", ")}.`;
    throw new VcsUsageError(
      name === "main" ? `This folder has no "main" exploration. ${known}` : `There is no exploration called "${name}". ${known}`,
    );
  }
  if ((await currentExploration(git)) === name) {
    return { exploration: name, switched: false, summary: `Already on exploration "${name}".` };
  }
  await refuseIfUnsaved(git, "switch");
  await git(["switch", "--no-guess", "--end-of-options", name]);
  return { exploration: name, switched: true, summary: `Switched to exploration "${name}".` };
}
