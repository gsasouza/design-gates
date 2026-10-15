export const version = "0.0.0";
export type {
  PenDocument,
  PenNode,
  PenThemes,
  PenVariable,
  PenVariables,
  PenVersion,
} from "./pen/types.js";
export { loadPenFile, parsePen } from "./pen/load.js";
export type { Renderer } from "./render/renderer.js";
export { createOpenPencilRenderer } from "./render/openpencil.js";
export type {
  ChangeBox,
  DiffDocs,
  DiffResult,
  FileDiff,
  FrameCounts,
  FrameDiff,
  FrameImages,
  FrameRef,
  NodeChange,
  PropChange,
  ThemeChange,
  ThemeKey,
  VariableChange,
} from "./diff/model.js";
export { serializeDiff } from "./diff/serialize.js";
export { matchFrames, structureHash } from "./diff/match.js";
export type { FrameMatches, FramePair } from "./diff/match.js";
export { diffFrame } from "./diff/semantic.js";
export type { FrameDiffResult } from "./diff/semantic.js";
export { diffVariables } from "./diff/variables.js";
export type { VariablesDiff } from "./diff/variables.js";
export { computeSemanticDiff, computeSemanticDiffWithDocs } from "./diff/compute.js";
export type { ComputeOptions } from "./diff/compute.js";
export { computeVisualDiff } from "./visual/compute.js";
export type { FileSystemSeam, VisualDiffOptions } from "./visual/compute.js";
export { pixelDiff } from "./visual/pixel-diff.js";
export type { PixelDiff, PixelDiffOptions } from "./visual/pixel-diff.js";
export { nodeChangeBoxes, pixelChangeBoxes, sortBoxes } from "./visual/change-boxes.js";
export { fileSlug } from "./visual/render-frames.js";
