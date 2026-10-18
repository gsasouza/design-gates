import type { CompiledDocument } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import { MAX_IGNORE_LENGTH, regexSource } from "../gates/tok.js";
import type { Violation } from "../gates/types.js";
import { contentViolation, ownTextNodes, sortViolations } from "./cnt-text.js";

const cache = new Map<string, RegExp | null>();

/** Case-insensitive regex of a `/source/` pattern, compiled once; null when invalid. */
function compile(source: string): RegExp | null {
  let re = cache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source, "i");
    } catch {
      re = null;
    }
    cache.set(source, re);
  }
  return re;
}

/** The first pattern matching `content`: `/regex/` anywhere in it, a plain string as the whole trimmed content. */
function firstMatch(content: string, patterns: readonly string[]): string | undefined {
  const head = content.slice(0, MAX_IGNORE_LENGTH);
  return patterns.find((pattern) => {
    const source = regexSource(pattern);
    if (source === undefined) return content.trim().toLowerCase() === pattern.toLowerCase();
    return pattern.length <= MAX_IGNORE_LENGTH && compile(source)?.test(head) === true;
  });
}

/** CNT-001: a text node whose content matches a placeholder pattern (opt-in). */
export function cnt001(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const { patterns } = config.rules["CNT-001"];
  const out: Violation[] = [];
  for (const node of ownTextNodes(compiled)) {
    const content = node.props.content;
    if (typeof content !== "string") continue;
    const pattern = firstMatch(content, patterns);
    if (pattern !== undefined) out.push(contentViolation(compiled, node, "CNT-001", `Placeholder text "${content}" matches ${pattern}`));
  }
  return sortViolations(out);
}
