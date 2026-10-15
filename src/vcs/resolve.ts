import { VcsUsageError } from "./errors.js";
import type { SafeGit } from "./git.js";
import { COMMIT_LINE_FORMAT, parseCommitLines, type Commit } from "./log.js";

export interface ResolvedVersion {
  sha: string;
  shortId: string;
  label: string;
}

interface Candidate extends ResolvedVersion {
  kind: "number" | "id" | "exploration";
}

const MIN_ID_LENGTH = 4;

/** Commits of the current exploration, newest first; empty when nothing is saved yet. */
export async function currentVersions(git: SafeGit): Promise<Commit[]> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return [];
  }
  return parseCommitLines(await git(["log", COMMIT_LINE_FORMAT]));
}

const quote = (m: string) => (m === "" ? "" : ` "${m}"`);

function describe(c: Candidate): string {
  return c.label;
}

/**
 * Resolves `#n`/`n` (n-th latest version on the current exploration), a short or full version id,
 * an exploration name, or `main`.
 */
export async function resolveVersion(git: SafeGit, input: string): Promise<ResolvedVersion> {
  const ref = input.trim();
  if (ref === "") throw new VcsUsageError("Say which version you mean, for example #1, a version id or an exploration name.");
  if (ref.startsWith("-")) throw new VcsUsageError(`A version can't start with a dash: ${ref}`);

  const numbered = /^#(\d+)$/.exec(ref);
  const bare = /^\d+$/.test(ref);
  const candidates: Candidate[] = [];
  let numberError: VcsUsageError | undefined;

  if (numbered || bare) {
    const n = Number(numbered ? numbered[1] : ref);
    const versions = await currentVersions(git);
    if (versions.length === 0) {
      numberError = new VcsUsageError("No versions saved yet.");
    } else if (n < 1 || n > versions.length) {
      numberError = new VcsUsageError(
        `There is no version #${n}. This exploration has ${versions.length} saved ${versions.length === 1 ? "version" : "versions"}.`,
      );
    } else {
      const c = versions[n - 1];
      candidates.push({ kind: "number", sha: c.sha, shortId: c.shortId, label: `version #${n} (${c.shortId})${quote(c.message)}` });
    }
    if (numbered) {
      if (numberError) throw numberError;
      return strip(candidates[0]);
    }
  }

  if (/^[0-9a-f]+$/i.test(ref) && ref.length >= MIN_ID_LENGTH) {
    const prefix = ref.toLowerCase();
    const all = parseCommitLines(await git(["log", "--branches", COMMIT_LINE_FORMAT]));
    for (const c of all) {
      if (c.sha.startsWith(prefix) && !candidates.some((x) => x.kind === "id" && x.sha === c.sha)) {
        candidates.push({ kind: "id", sha: c.sha, shortId: c.shortId, label: `version ${c.shortId}${quote(c.message)}` });
      }
    }
  }

  const branches = await git(["for-each-ref", "--format=%(refname:short) %(objectname) %(objectname:short)", "refs/heads/"]);
  for (const line of branches.split("\n")) {
    if (line === "") continue;
    const [name, sha, shortId] = line.split(" ");
    if (name === ref) candidates.push({ kind: "exploration", sha, shortId, label: `exploration "${name}"` });
  }

  if (candidates.length === 1) return strip(candidates[0]);
  if (candidates.length > 1) {
    throw new VcsUsageError(
      `"${ref}" could mean more than one thing: ${candidates.map(describe).join("; ")}. Use #n or a longer version id to be specific.`,
    );
  }
  if (numberError) throw numberError;
  throw new VcsUsageError(`There is no version, exploration or "main" called "${ref}".`);
}

function strip(c: Candidate): ResolvedVersion {
  return { sha: c.sha, shortId: c.shortId, label: c.label };
}
