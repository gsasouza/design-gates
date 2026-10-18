import type { CompiledDocument } from "../compile/types.js";
import type { VariablesDiff } from "../diff/variables.js";
import type { PenNode } from "../pen/types.js";
import type { GatesConfig } from "./config.js";

/** Only `block` can fail a run; `info` is purely informational. */
export type Severity = "block" | "warn" | "review" | "info";

/** A suggested change; fixes are only reported, never applied. */
export type Fix =
  | { type: "replace"; prop: string; value: unknown }
  | { type: "candidates"; prop: string; candidates: unknown[] }
  | { type: "ref"; ref: string; descendants: Record<string, Partial<PenNode>> }
  | { type: "remove" };

export interface Violation {
  rule: string;
  severity: Severity;
  /** Repo-relative POSIX path of the .pen file. */
  file: string;
  /** Compiled node id (see CompiledNode.id). */
  nodeId: string;
  path: string;
  prop?: string;
  message: string;
  fix?: Fix;
  /** Sorted instance ids, for a violation inherited from a component and reported once on it. */
  affectedInstances?: string[];
  /** Theme combination as `axis=value,axis=value` (axes sorted), like the diff's theme keys. */
  theme?: string;
  /** Set when the severity is fixed by the rule and `rules.<ID>.severity` must not change it. */
  fixedSeverity?: boolean;
}

/** What the DIF-001 style rules need beyond the head document. */
export interface DiffContext {
  base?: CompiledDocument;
  head: CompiledDocument;
  /** Variable and theme changes of this file only. */
  variables?: VariablesDiff;
}

export type Rule = (compiled: CompiledDocument, config: GatesConfig, diff?: DiffContext) => Violation[];
