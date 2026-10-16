import { createGitReader } from "../git/exec.js";
import { defaultBase, type GitReader, WORKTREE } from "../git/reader.js";
import type { PenDocument, PenNode } from "../pen/types.js";
import { designFormatOf } from "../source/format.js";
import { readDesignSource } from "../source/read.js";
import { matchFrames } from "./match.js";
import type { DiffDocs, DiffResult, DiffSources, FileDiff, FrameDiff, MatchedBy } from "./model.js";
import { diffFrame } from "./semantic.js";
import { diffVariables } from "./variables.js";

export interface ComputeOptions {
  repo: string;
  /** Base ref; defaults to `git merge-base main HEAD`. */
  base?: string;
  /** Head ref; defaults to the working tree. */
  head?: string;
  /** Glob pathspecs narrowing the `.pen`/`.fig` files considered. */
  paths?: string[];
  /** Injected git access, mainly for tests. */
  git?: GitReader;
}

const NO_COUNTS = { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 };

function frameEntry(node: PenNode, status: "added" | "removed"): FrameDiff {
  return {
    id: node.id,
    name: node.name ?? "",
    ...(status === "added" ? { headId: node.id } : { baseId: node.id }),
    status,
    matchedBy: null,
    counts: { ...NO_COUNTS },
    nodes: [],
    changeBoxes: [],
    missingBoxes: [],
    pixelDiffRatio: null,
    images: null,
  };
}

function diffFrames(base: PenDocument | undefined, head: PenDocument | undefined): FrameDiff[] {
  const m = matchFrames(base?.children ?? [], head?.children ?? []);
  const frames: FrameDiff[] = m.pairs.map((p) => {
    const d = diffFrame(p.base, p.head, p.matchedBy as MatchedBy);
    return {
      id: p.head.id ?? p.base.id,
      name: p.head.name ?? p.base.name ?? "",
      baseId: p.base.id,
      headId: p.head.id,
      status: d.nodes.length ? "modified" : "unchanged",
      matchedBy: p.matchedBy,
      counts: d.counts,
      nodes: d.nodes,
      changeBoxes: [],
      missingBoxes: [],
      pixelDiffRatio: null,
      images: null,
    };
  });
  for (const n of m.added) frames.push(frameEntry(n, "added"));
  for (const n of m.removed) frames.push(frameEntry(n, "removed"));
  return frames;
}

/** Semantic diff plus the parsed documents and sources it was computed from (keyed by result path). */
export async function computeSemanticDiffWithDocs(
  opts: ComputeOptions,
): Promise<{ result: DiffResult; docs: DiffDocs; sources: DiffSources }> {
  const git = opts.git ?? createGitReader(opts.repo);
  const baseRef = opts.base ?? (await defaultBase(git));
  // A commit's merge base with itself is its own sha; this also validates the ref.
  const baseSha = await git.mergeBase(baseRef, baseRef);
  const worktree = opts.head === undefined;
  const headSha = worktree ? "WORKTREE" : await git.mergeBase(opts.head!, opts.head!);

  const changed = await git.listChangedDesignFiles(baseSha, worktree ? WORKTREE : headSha, opts.paths ?? []);
  const files: FileDiff[] = [];
  const docs: DiffDocs = {};
  const sources: DiffSources = {};
  for (const f of [...changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const baseSource =
      f.status === "added" ? undefined : await readDesignSource(git, baseSha, f.oldPath ?? f.path);
    const headSource =
      f.status === "removed" ? undefined : await readDesignSource(git, worktree ? WORKTREE : headSha, f.path);
    const base = baseSource?.doc;
    const head = headSource?.doc;
    docs[f.path] = { ...(base && { base }), ...(head && { head }) };
    sources[f.path] = { ...(baseSource && { base: baseSource }), ...(headSource && { head: headSource }) };
    files.push({
      path: f.path,
      ...(f.oldPath !== undefined && { oldPath: f.oldPath }),
      status: f.status,
      format: designFormatOf(f.path) ?? "pen",
      frames: diffFrames(base, head),
    });
  }

  const { variables, themes } = diffVariables(docs);
  const result: DiffResult = {
    schemaVersion: 1,
    base: { ref: opts.base ?? "merge-base(main,HEAD)", sha: baseSha },
    head: { ref: opts.head ?? "WORKTREE", sha: headSha },
    files,
    variables,
    themes,
  };
  return { result, docs, sources };
}

export async function computeSemanticDiff(opts: ComputeOptions): Promise<DiffResult> {
  return (await computeSemanticDiffWithDocs(opts)).result;
}
