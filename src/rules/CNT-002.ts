import type { CompiledDocument } from "../compile/types.js";
import type { Violation } from "../gates/types.js";
import { contentViolation, ownTextNodes, sortViolations } from "./cnt-text.js";

/** CNT-002: a text node whose content is missing, not a string, empty or whitespace-only (opt-in). */
export function cnt002(compiled: CompiledDocument): Violation[] {
  const out = ownTextNodes(compiled)
    .filter((node) => typeof node.props.content !== "string" || node.props.content.trim() === "")
    .map((node) => contentViolation(compiled, node, "CNT-002", "Text has no content", { fix: { type: "remove" } }));
  return sortViolations(out);
}
