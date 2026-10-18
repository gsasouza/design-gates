import { getNode } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import { CONTROLLED_PROPS, MAX_IGNORE_LENGTH } from "../gates/tok.js";
import type { Rule, Violation } from "../gates/types.js";
import { globToRegExp, literalSlots } from "./tok-slots.js";

const MAX_VALUE_DEPTH = 8;
const ALL_CONTROLLED: ReadonlySet<(typeof CONTROLLED_PROPS)[number]> = new Set(CONTROLLED_PROPS);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** True when a string starting with `$` appears anywhere in the value. */
function hasVariable(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.startsWith("$");
  if (depth >= MAX_VALUE_DEPTH || typeof value !== "object" || value === null) return false;
  return Object.values(value).some((v) => hasVariable(v, depth + 1));
}

/** A literal in a controlled property: TOK-001 / TOK-005 own it, so CMP-002 stays silent. */
const isControlledLiteral = (key: string, value: unknown): boolean =>
  !hasVariable(value) && literalSlots({ props: { [key]: value } } as unknown as CompiledNode, ALL_CONTROLLED).length > 0;

/** Present, non-false `slot` property. */
const isSlot = (node: CompiledNode): boolean => node.props.slot !== undefined && node.props.slot !== false;

/** Nodes of the component definition along an override path, below the root; undefined when the path does not resolve. */
export function targetChain(compiled: CompiledDocument, component: CompiledNode, path: string): CompiledNode[] | undefined {
  const chain: CompiledNode[] = [];
  let at = component;
  for (const seg of path.split("/")) {
    const next = at.children.map((id) => getNode(compiled, id)).find((c) => c?.sourceId === seg);
    if (!next) return undefined;
    chain.push(next);
    at = next;
  }
  return chain;
}

/** CMP-002: an instance override outside the component's allowlist, or a node/children replacement outside a slot (opt-in). */
export const cmp002: Rule = (compiled, config) => {
  const allowed = Object.entries(config.rules["CMP-002"].allowedOverrides).map(([glob, keys]) => ({ re: globToRegExp(glob), keys }));
  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    if (node.expanded || node.overrides === undefined || node.instanceOf === undefined) continue;
    const component = getNode(compiled, node.instanceOf);
    if (!component) continue;
    const name = typeof component.props.name === "string" ? component.props.name : component.id;
    const keys = allowed.find(({ re }) => re.test(component.id.slice(0, MAX_IGNORE_LENGTH)) || (typeof component.props.name === "string" && re.test(component.props.name.slice(0, MAX_IGNORE_LENGTH))))?.keys ?? [];
    const report = (path: string, key: string, message: string): void => {
      out.push({ rule: "CMP-002", severity: "warn", file: compiled.file, nodeId: node.id, path: node.path, prop: `descendants.${path}.${key}`, message });
    };
    for (const [path, props] of Object.entries(node.overrides)) {
      const chain = targetChain(compiled, component, path);
      if (!chain) continue;
      const target = chain[chain.length - 1]!;
      for (const key of Object.keys(props)) {
        if (key === "type") {
          if (!chain.some(isSlot)) report(path, key, `override of "type" on descendants path "${path}" replaces a node outside a slot in component "${name}"`);
        } else if (key === "children") {
          if (!isSlot(target)) report(path, key, `override of "children" on descendants path "${path}" replaces the children of a frame that is not a slot in component "${name}"`);
        } else if (!keys.includes(key) && !isControlledLiteral(key, props[key])) {
          report(path, key, `override of "${key}" on descendants path "${path}" is not allowed by component "${name}" (allowed: ${keys.length ? keys.join(", ") : "none"})`);
        }
      }
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
};
