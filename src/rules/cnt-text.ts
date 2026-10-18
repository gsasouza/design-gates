import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { Violation } from "../gates/types.js";
import { affectedInstances } from "./tok-slots.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Text nodes whose `content` is set by the node itself. Content inherited from a component (provenance
 * absent or origin `component`) is only reported on the defining node; instance and descendants overrides
 * are reported on the overriding node.
 */
export function ownTextNodes(compiled: CompiledDocument): CompiledNode[] {
  return compiled.nodes.filter((n) => n.type === "text" && !(n.expanded && (n.provenance.content === undefined || n.provenance.content.origin === "component")));
}

/** A violation of `rule` on a text node's `content`, with `affectedInstances` when the node is inside a component. */
export function contentViolation(compiled: CompiledDocument, node: CompiledNode, rule: string, message: string, extra: Partial<Violation> = {}): Violation {
  const instances = affectedInstances(compiled, node);
  return { rule, severity: "warn", file: compiled.file, nodeId: node.id, path: node.path, prop: "content", message, ...extra, ...(instances ? { affectedInstances: instances } : {}) };
}

export const sortViolations = (list: Violation[]): Violation[] => list.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
