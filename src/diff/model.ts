import type { PenDocument } from "../pen/types.js";

/** "default", or "axis=value" pairs sorted by axis and joined with ",". */
export type ThemeKey = string;

export type FileStatus = "added" | "removed" | "modified" | "renamed";
export type FrameStatus = "added" | "removed" | "modified" | "unchanged";
export type MatchedBy = "id" | "structure" | "name";
export type NodeChangeKind = "added" | "removed" | "modified" | "moved" | "reordered";

export interface PropChange {
  path: string;
  old: unknown;
  new: unknown;
}

export interface NodeChange {
  id: string;
  name: string;
  type: string;
  change: NodeChangeKind;
  props?: PropChange[];
  from?: string;
  to?: string;
}

export interface ChangeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: NodeChangeKind | "pixel";
  side: "base" | "head";
  nodeId?: string;
  name?: string;
}

export type FrameImages = Record<ThemeKey, { base?: string; head?: string; diff?: string }> | null;

export interface FrameCounts {
  added: number;
  removed: number;
  modified: number;
  moved: number;
  reordered: number;
}

export interface FrameDiff {
  id: string;
  name: string;
  baseId?: string;
  headId?: string;
  status: FrameStatus;
  matchedBy: MatchedBy | null;
  counts: FrameCounts;
  nodes: NodeChange[];
  changeBoxes: ChangeBox[];
  missingBoxes: string[];
  pixelDiffRatio: Record<ThemeKey, number> | null;
  images: FrameImages;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  frames: FrameDiff[];
}

export interface FrameRef {
  file: string;
  frameId: string;
}

export interface VariableChange {
  file: string;
  name: string;
  change: "added" | "removed" | "modified";
  theme?: string;
  old?: unknown;
  new?: unknown;
  frames: FrameRef[];
}

export interface ThemeChange {
  file: string;
  name: string;
  change: "added" | "removed";
  frames: FrameRef[];
}

export interface DiffResult {
  schemaVersion: 1;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string | "WORKTREE" };
  files: FileDiff[];
  variables: VariableChange[];
  themes: ThemeChange[];
}

/** Parsed documents per result file path. */
export type DiffDocs = Record<string, { base?: PenDocument; head?: PenDocument }>;
