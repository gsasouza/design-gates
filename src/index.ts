export const version = "0.0.0";
export type {
  PenDocument,
  PenNode,
  PenThemes,
  PenVariable,
  PenVariables,
  PenVersion,
  PenColor,
  PenEffect,
  PenFill,
  PenFillObject,
  PenGradientStop,
  PenStroke,
} from "./pen/types.js";
export { gradientStops, solidColor } from "./pen/paint.js";
export { MAX_ALIAS_DEPTH, resolveAlias } from "./render/themes.js";
export type { ResolveResult } from "./render/themes.js";
export { compile } from "./compile/compile.js";
export { getNode, iterateNodes, listComponents, listInstances, resolveForTheme, themeCombinations, topFrameOf } from "./compile/query.js";
export type { ThemeCombination } from "./compile/query.js";
export { KNOWN_TYPES, KNOWN_VERSIONS } from "./compile/constants.js";
export type { CompileDiagnostic, CompileOptions, CompiledDocument, CompiledNode, DiagnosticRule, Provenance, VariableUse } from "./compile/types.js";
export type { DiffContext, Fix, Rule, Severity, Violation } from "./gates/types.js";
export { DEFAULT_CONFIG, OPT_IN_RULES, RULE_IDS, resolveConfig } from "./gates/config.js";
export type { ConfigResult, GatesConfig, RuleConfig, RuleId, SeverityOverride } from "./gates/config.js";
export { registry, runRules } from "./rules/index.js";
export { parseFailureViolation } from "./rules/parse-failure.js";
export type { RuleEntry, RuleInput } from "./rules/index.js";
export { loadPenFile, parsePen } from "./pen/load.js";
export type { Renderer } from "./render/renderer.js";
export { createOpenPencilRenderer } from "./render/openpencil.js";
export { designFormatOf } from "./source/format.js";
export type { DesignFormat } from "./source/format.js";
export type { DesignSource } from "./source/types.js";
export { MAX_FIG_BYTES, MAX_FIG_INFLATED_BYTES, loadDesignSource, penSource } from "./source/load.js";
export type { LoadLimits } from "./source/load.js";
export { readDesignSource } from "./source/read.js";
export { figSceneToPen } from "./fig/normalize.js";
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
export type { FrameMatches, FramePair, StructureHashOptions } from "./diff/match.js";
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
export { renderReport } from "./report/render-report.js";
export type { RenderReportOptions } from "./report/render-report.js";
export { ALLOWED_GIT_SUBCOMMANDS, createSafeGit, createVcsExecFileGit } from "./vcs/git.js";
export type { SafeGit } from "./vcs/git.js";
export { VcsCommitFailedError, VcsRefusedError, VcsUsageError, classifyCommitFailure } from "./vcs/errors.js";
export { resolveRepoPath } from "./vcs/paths.js";
export { resolveVersion } from "./vcs/resolve.js";
export type { ResolvedVersion } from "./vcs/resolve.js";
export { getUnsavedChanges } from "./vcs/state.js";
export type { ChangedFile, FileState, UnsavedChanges } from "./vcs/state.js";
export { createDesignRepo, defaultSaveMessage } from "./vcs/repo.js";
export type { DesignRepo, DesignRepoOptions, HistoryResult, HistoryVersion, InitResult, SaveResult, StatusResult } from "./vcs/repo.js";
export { buildDiffReport } from "./cli/run-diff.js";
export { compare, defaultOpenFile, openerFor } from "./vcs/compare.js";
export type { CompareDeps, CompareOptions, CompareResult } from "./vcs/compare.js";
export { restoreVersion } from "./vcs/restore.js";
export type { RestoreDeps, RestoreOptions, RestoreResult } from "./vcs/restore.js";
export { exploreOrList, switchExploration } from "./vcs/explore.js";
export type { Exploration, ExploreResult, SwitchResult } from "./vcs/explore.js";
