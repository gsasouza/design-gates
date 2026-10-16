import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { Violation } from "../gates/types.js";

const UNJUDGEABLE_PAINTS = new Set(["image", "gradient", "unsupported"]);

function hasUnjudgeablePaint(value: unknown): boolean {
  const paints = Array.isArray(value) ? value : [value];
  return paints.some((p) => {
    if (typeof p !== "object" || p === null) return false;
    const o = p as { type?: unknown; fill?: unknown };
    return (typeof o.type === "string" && UNJUDGEABLE_PAINTS.has(o.type)) || (o.fill !== undefined && hasUnjudgeablePaint(o.fill));
  });
}

/** A node the normalizer only approximated (`figType`) or that paints with an image, gradient or unsupported paint. */
function figOnly(node: CompiledNode): boolean {
  return node.props.figType !== undefined || hasUnjudgeablePaint(node.props.fill) || hasUnjudgeablePaint(node.props.stroke);
}

/**
 * The single choke point for fig-only constructs: a rule cannot judge what the normalizer could not
 * map exactly, so a `block` there becomes a `review` that rule config cannot change. A `.pen` is untouched.
 */
export function downgradeFigBlocks(violations: readonly Violation[], compiled: CompiledDocument): Violation[] {
  if (compiled.format !== "fig") return [...violations];
  const nodes = new Map(compiled.nodes.map((n) => [n.id, n]));
  return violations.map((v) => {
    const node = nodes.get(v.nodeId);
    if (v.severity !== "block" || !node || !figOnly(node)) return v;
    return { ...v, severity: "review", fixedSeverity: true, message: `${v.message}; involves a .fig construct that cannot be fully judged` };
  });
}
