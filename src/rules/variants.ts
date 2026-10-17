import type { CompiledDocument, CompiledNode } from "../compile/types.js";

export type CandidateKind = "screen" | "component";

/** A screen (top-level non-reusable frame) or a reusable component that can have variants. */
export interface Candidate {
  node: CompiledNode;
  kind: CandidateKind;
  /** `props.name` if a string, else the source id. */
  name: string;
}

export type VariantKey = "state" | "breakpoint";

/**
 * Naming inputs, built by the caller from the resolved config of STA-001 and RSP-001 whether or
 * not those rules are enabled. Naming-based breakpoint detection applies only when `breakpoints`
 * is non-empty; otherwise breakpoints are detected by metadata only.
 */
export interface VariantNaming {
  /** Contains `{name}` and `{state}`. */
  statePattern: string;
  states: readonly string[];
  /** Contains `{name}` and `{breakpoint}`. */
  breakpointPattern?: string;
  breakpoints: readonly string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (s: string): string => s.trim().toLowerCase();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `design-gates` metadata marker of a node, if it has one. */
export function markerOf(node: CompiledNode): Record<string, unknown> | undefined {
  const meta = node.props.metadata;
  return isObject(meta) && meta.type === "design-gates" ? meta : undefined;
}

/** Screens and components of the document, sorted by compiled id. A node is never both. */
export function listCandidates(compiled: CompiledDocument): Candidate[] {
  const top = new Set(compiled.topLevel);
  const out: Candidate[] = [];
  for (const node of compiled.nodes) {
    if (node.expanded) continue;
    const kind: CandidateKind | undefined = node.props.reusable === true ? "component" : top.has(node.id) && node.type === "frame" ? "screen" : undefined;
    if (kind) out.push({ node, kind, name: typeof node.props.name === "string" ? node.props.name : node.sourceId });
  }
  return out.sort((a, b) => cmp(a.node.id, b.node.id));
}

const patternFor = (pattern: string, placeholder: string, base: Candidate, key: string): string =>
  norm(pattern.split("{name}").join(base.name).split(placeholder).join(key));

const keysOf = (naming: VariantNaming, kind: VariantKey): { pattern: string | undefined; keys: readonly string[] } =>
  kind === "state" ? { pattern: naming.statePattern, keys: naming.states } : { pattern: naming.breakpointPattern, keys: naming.breakpoints };

/** Metadata `variantOf` refers to a candidate by compiled id, source id or display name. */
const refersTo = (ref: unknown, base: Candidate): boolean =>
  typeof ref === "string" && ref !== "" && (ref === base.node.id || ref === base.node.sourceId || ref === base.name);

function viaMetadata(variant: Candidate, base: Candidate, kind: VariantKey, key: string | undefined): boolean {
  const marker = markerOf(variant.node);
  const value = marker?.[kind];
  if (!marker || !refersTo(marker.variantOf, base) || typeof value !== "string" || value.trim() === "") return false;
  return key === undefined || norm(value) === norm(key);
}

function viaNaming(variant: Candidate, base: Candidate, kind: VariantKey, key: string | undefined, naming: VariantNaming): boolean {
  const { pattern, keys } = keysOf(naming, kind);
  if (!pattern) return false;
  const placeholder = kind === "state" ? "{state}" : "{breakpoint}";
  const name = norm(variant.name);
  return (key === undefined ? keys : [key]).some((k) => patternFor(pattern, placeholder, base, k) === name);
}

const isVariantOf = (variant: Candidate, base: Candidate, kind: VariantKey, key: string | undefined, naming: VariantNaming): boolean =>
  variant.node.id !== base.node.id && variant.kind === base.kind && (viaNaming(variant, base, kind, key, naming) || viaMetadata(variant, base, kind, key));

/** Variants of `base` for one state or breakpoint, by naming or metadata, sorted by id. */
export function variantsOf(candidates: readonly Candidate[], base: Candidate, kind: VariantKey, key: string, naming: VariantNaming): Candidate[] {
  return candidates.filter((c) => isVariantOf(c, base, kind, key, naming));
}

/** Whether `node` is a state or breakpoint variant of another candidate of its kind. */
export function isVariant(candidates: readonly Candidate[], node: Candidate, naming: VariantNaming): boolean {
  return candidates.some((base) => (["state", "breakpoint"] as const).some((kind) => isVariantOf(node, base, kind, undefined, naming)));
}
