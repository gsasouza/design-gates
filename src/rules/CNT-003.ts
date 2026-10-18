import type { CompiledDocument } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import { MAX_IGNORE_LENGTH } from "../gates/tok.js";
import type { Violation } from "../gates/types.js";
import { sortViolations } from "./cnt-text.js";
import { listCandidates } from "./variants.js";

const cache = new Map<string, RegExp | null>();

/** Anchored, case-sensitive regex of a pattern source, compiled once; null when invalid. */
function compileFull(source: string): RegExp | null {
  let re = cache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${source})$`);
    } catch {
      re = null;
    }
    cache.set(source, re);
  }
  return re;
}

/** CNT-003: a component or screen without a name, or with a default name such as `Frame 12` (opt-in). */
export function cnt003(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const re = compileFull(config.rules["CNT-003"].pattern);
  const out: Violation[] = [];
  for (const { node, kind } of listCandidates(compiled)) {
    const name = node.props.name;
    const message =
      typeof name !== "string"
        ? `The ${kind} name is missing`
        : re?.test(name.slice(0, MAX_IGNORE_LENGTH)) === true
          ? `The ${kind} has the default name "${name}"`
          : undefined;
    if (message !== undefined) out.push({ rule: "CNT-003", severity: kind === "component" ? "warn" : "info", file: compiled.file, nodeId: node.id, path: node.path, prop: "name", message });
  }
  return sortViolations(out);
}
