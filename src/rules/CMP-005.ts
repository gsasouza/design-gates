import { isDeepStrictEqual } from "node:util";
import { getNode } from "../compile/query.js";
import { normalizeColor } from "../gates/tok.js";
import type { Rule, Violation } from "../gates/types.js";
import { targetChain } from "./CMP-002.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Keys whose value is a colour or paint when written at the top level of an override. */
const TOP_COLOR_KEYS: ReadonlySet<string> = new Set(["fill", "stroke", "color"]);
/** Keys that hold a colour inside a paint object. */
const PAINT_COLOR_KEYS: ReadonlySet<string> = new Set(["color", "fill"]);

/** The value with hex colours in colour-bearing positions normalised; everything else is kept raw. */
function normalized(value: unknown, colour: boolean): unknown {
  if (typeof value === "string") return colour ? (normalizeColor(value) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => normalized(v, colour));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v, PAINT_COLOR_KEYS.has(k))]));
}

/** Raw structural equality (no variable resolution); colours compare normalised in colour positions. */
const sameValue = (key: string, a: unknown, b: unknown): boolean => isDeepStrictEqual(normalized(a, TOP_COLOR_KEYS.has(key)), normalized(b, TOP_COLOR_KEYS.has(key)));

/** CMP-005: an instance override whose value equals the component's own value at that path and key (opt-in). */
export const cmp005: Rule = (compiled) => {
  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    if (node.expanded || node.overrides === undefined || node.instanceOf === undefined) continue;
    const component = getNode(compiled, node.instanceOf);
    if (!component) continue;
    for (const [path, props] of Object.entries(node.overrides)) {
      const target = targetChain(compiled, component, path)?.at(-1);
      if (!target) continue;
      for (const [key, value] of Object.entries(props)) {
        if (key === "type" || key === "children" || !Object.hasOwn(target.props, key) || !sameValue(key, value, target.props[key])) continue;
        const prop = `descendants.${path}.${key}`;
        out.push({
          rule: "CMP-005",
          severity: "info",
          file: compiled.file,
          nodeId: node.id,
          path: node.path,
          prop,
          message: `override of "${key}" on descendants path "${path}" equals the component value; remove it`,
          fix: { type: "remove", prop },
        });
      }
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
};
