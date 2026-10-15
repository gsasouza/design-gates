import type { PenDocument, PenNode, PenThemes, PenVariable, PenVariables } from "../pen/types.js";

export function findNode(nodes: PenNode[], id: string): PenNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Deep copy of `doc` whose frame `frameId` pins `theme` (axis -> value); the subtree inherits it.
 * Axes already pinned on the frame are kept unless `theme` overrides them. The caller's document
 * is never mutated.
 */
export function withFrameTheme(doc: PenDocument, frameId: string, theme?: Record<string, string>): PenDocument {
  const copy = structuredClone(doc);
  if (!theme) return copy;
  const frame = findNode(copy.children, frameId);
  if (!frame) throw new Error(`Frame not found: ${frameId}`);
  frame.theme = { ...frame.theme, ...theme };
  return copy;
}

const VARIABLE_REF = /^\$[^\s$]+$/;
/** Keys whose string values are data, never variable references. */
const LITERAL_KEYS = new Set(["id", "name", "content", "type", "ref"]);

/** True when `value` under property `key` is a variable reference (`$name`); the renderer's one definition. */
export function isVariableRef(key: string | undefined, value: unknown): value is string {
  return typeof value === "string" && !(key !== undefined && LITERAL_KEYS.has(key)) && VARIABLE_REF.test(value);
}

export type Theme = Record<string, string>;

function isTheme(value: unknown): value is Theme {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Value of `variable` under `theme`: the last entry (document order) whose theme is satisfied; no theme is always satisfied. */
export function resolveVariable(variable: PenVariable, theme: Theme): unknown {
  if (!Array.isArray(variable.value)) return variable.value;
  const entries = variable.value as { value: unknown; theme?: Theme }[];
  return entries.filter((e) => Object.entries(e.theme ?? {}).every(([axis, v]) => theme[axis] === v)).at(-1)?.value;
}

/** Longest alias chain followed before giving up (bounds untrusted documents). */
export const MAX_ALIAS_DEPTH = 256;

/**
 * Outcome of following a `$name` alias chain:
 * - `ok`: `value` is the concrete value;
 * - `undefined`: a variable in the chain is not declared;
 * - `no-value`: a variable is declared but no entry matches the theme;
 * - `cycle`: the chain revisits a variable (the last `chain` entry repeats an earlier one);
 * - `too-deep`: the chain exceeds MAX_ALIAS_DEPTH.
 * `chain` lists the variable names visited (without `$`), including the one that ended the walk;
 * for every status but `ok`, `value` is the unresolved `$name` reference.
 */
export interface ResolveResult {
  value: unknown;
  chain: string[];
  status: "ok" | "undefined" | "no-value" | "cycle" | "too-deep";
}

/** Resolve `$name` to a concrete value for `theme`, following alias chains. Bounded; never throws. */
export function resolveAlias(ref: string, variables: PenVariables, theme: Theme): ResolveResult {
  const chain: string[] = [];
  let current: unknown = ref;
  while (typeof current === "string" && VARIABLE_REF.test(current)) {
    const name = current.slice(1);
    if (chain.includes(name)) return { value: current, chain: [...chain, name], status: "cycle" };
    if (chain.length >= MAX_ALIAS_DEPTH) return { value: current, chain, status: "too-deep" };
    chain.push(name);
    const variable = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (!variable) return { value: current, chain, status: "undefined" };
    const next = resolveVariable(variable, theme);
    if (next === undefined) return { value: current, chain, status: "no-value" };
    current = next;
  }
  return { value: current, chain, status: "ok" };
}

/** Renderer wrapper over resolveAlias: unresolvable references stay as `$name`; a cycle throws. */
function resolveReference(ref: string, variables: PenVariables, theme: Theme): unknown {
  const result = resolveAlias(ref, variables, theme);
  if (result.status === "cycle") throw new Error(`Variable alias cycle: ${result.chain.map((n) => `$${n}`).join(" -> ")}`);
  if (result.status === "too-deep") throw new Error(`Variable alias chain too deep: ${ref}`);
  return result.value;
}

/**
 * Replace `$variable` references under `value` with their concrete value for the theme in effect
 * at that point (a node's own `theme` pin overrides the inherited one). OpenPencil's .pen
 * import resolves variables at the first theme regardless of `theme` pins, so the theme is applied
 * here instead and the importer only ever sees literals.
 */
export function bakeVariables(value: unknown, variables: PenVariables, theme: Theme, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? (isVariableRef(key, v) ? resolveReference(v, variables, theme) : v) : bakeVariables(v, variables, theme, key)));
  }
  if (typeof value !== "object" || value === null) return value;
  const node = value as Record<string, unknown>;
  const here = isTheme(node.theme) ? { ...theme, ...node.theme } : theme;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(node)) {
    if (typeof v === "string") {
      out[key] = isVariableRef(key, v) ? resolveReference(v, variables, here) : v;
    } else {
      out[key] = key === "theme" ? v : bakeVariables(v, variables, here, key);
    }
  }
  return out;
}

/** Axis defaults: the first value of each declared theme axis. */
export function defaultTheme(themes: PenThemes | undefined): Theme {
  return Object.fromEntries(Object.entries(themes ?? {}).flatMap(([axis, values]) => (values[0] ? [[axis, values[0]]] : [])));
}

/** Theme in effect at the node `id`: axis defaults overridden by the `theme` pins on its ancestors and itself. */
function effectiveTheme(nodes: PenNode[], id: string, inherited: Theme): Theme | undefined {
  for (const node of nodes) {
    const here = isTheme(node.theme) ? { ...inherited, ...node.theme } : inherited;
    if (node.id === id) return here;
    const found = node.children && effectiveTheme(node.children, id, here);
    if (found) return found;
  }
  return undefined;
}

/**
 * Copy of `doc` for OpenPencil with `theme` pinned on the frame and every variable reference
 * resolved for the theme in effect. Reusable components outside the frame are baked with the
 * frame's effective theme; an instance whose own effective theme differs gets a copy of its
 * component baked with that theme instead. The caller's document is never mutated.
 */
export function prepareDocument(doc: PenDocument, frameId: string, theme?: Theme): PenDocument {
  const copy = withFrameTheme(doc, frameId, theme && findNode(doc.children, frameId) ? theme : undefined);
  const variables = copy.variables ?? {};
  const base = defaultTheme(copy.themes);
  const frameTheme = effectiveTheme(copy.children, frameId, base) ?? base;
  const children = bakeVariables(copy.children, variables, frameTheme) as PenNode[];
  const variants: PenNode[] = [];
  const made = new Map<string, string>();
  const frameKey = JSON.stringify(sorted(frameTheme));

  /** Re-point instances under `node` whose theme differs from the frame's at a component baked for their theme. */
  const retarget = (node: PenNode, parent: Theme): void => {
    const here = isTheme(node.theme) ? { ...parent, ...node.theme } : parent;
    const hereKey = JSON.stringify(sorted(here));
    if (typeof node.ref === "string" && hereKey !== frameKey) {
      const key = `${node.ref}\u0000${hereKey}`;
      let id = made.get(key);
      const component = findNode(copy.children, node.ref);
      if (id === undefined && component) {
        const n = made.size + 1;
        id = `${node.ref}@${n}`;
        made.set(key, id);
        const variant = suffixIds(bakeVariables({ ...component, id }, variables, here) as PenNode, `@${n}`, true);
        variants.push(variant);
        retarget(variant, here);
      }
      if (id !== undefined) {
        node.ref = id;
        const overrides = node.descendants;
        if (typeof overrides === "object" && overrides !== null && !Array.isArray(overrides)) {
          const suffix = id.slice(id.lastIndexOf("@"));
          node.descendants = Object.fromEntries(
            Object.entries(overrides as Record<string, unknown>).map(([path, v]) => [path.split("/").map((seg) => `${seg}${suffix}`).join("/"), v]),
          ) as typeof node.descendants;
        }
      }
    }
    for (const child of node.children ?? []) retarget(child, here);
  };
  const frame = findNode(children, frameId);
  if (frame) retarget(frame, inheritedTheme(copy.children, frameId, base) ?? base);
  return { ...copy, children: [...children, ...variants] };
}

/** Copy of `node` with `suffix` appended to every descendant id (the root keeps its id), so a variant's ids stay unique in the document. */
function suffixIds(node: PenNode, suffix: string, isRoot = false): PenNode {
  return { ...node, id: isRoot ? node.id : `${node.id}${suffix}`, ...(node.children ? { children: node.children.map((c) => suffixIds(c, suffix)) } : {}) };
}

const sorted = (theme: Theme): [string, string][] => Object.entries(theme).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Theme inherited by the node `id` from its ancestors (excluding its own pin). */
function inheritedTheme(nodes: PenNode[], id: string, inherited: Theme): Theme | undefined {
  for (const node of nodes) {
    if (node.id === id) return inherited;
    const here = isTheme(node.theme) ? { ...inherited, ...node.theme } : inherited;
    const found = node.children && inheritedTheme(node.children, id, here);
    if (found) return found;
  }
  return undefined;
}
