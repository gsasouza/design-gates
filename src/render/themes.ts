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

type Theme = Record<string, string>;

function isTheme(value: unknown): value is Theme {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Value of `variable` under `theme`: the last entry (document order) whose theme is satisfied; no theme is always satisfied. */
export function resolveVariable(variable: PenVariable, theme: Theme): unknown {
  if (!Array.isArray(variable.value)) return variable.value;
  const entries = variable.value as { value: unknown; theme?: Theme }[];
  return entries.filter((e) => Object.entries(e.theme ?? {}).every(([axis, v]) => theme[axis] === v)).at(-1)?.value;
}

/** Resolve `$name` to a concrete value, following alias chains (a variable whose value is `$other`). */
function resolveReference(ref: string, variables: PenVariables, theme: Theme): unknown {
  const seen: string[] = [];
  let current: unknown = ref;
  while (typeof current === "string" && VARIABLE_REF.test(current)) {
    const name = current.slice(1);
    const variable = variables[name];
    const next = variable ? resolveVariable(variable, theme) : undefined;
    if (next === undefined) return current;
    if (seen.includes(name)) throw new Error(`Variable alias cycle: ${[...seen, name].map((n) => `$${n}`).join(" -> ")}`);
    seen.push(name);
    current = next;
  }
  return current;
}

/**
 * Replace `$variable` references under `value` with their concrete value for the theme in effect
 * at that point (a node's own `theme` pin overrides the inherited one). OpenPencil 0.15's .pen
 * import resolves variables at the first theme regardless of `theme` pins, so the theme is applied
 * here instead and the importer only ever sees literals.
 */
export function bakeVariables(value: unknown, variables: PenVariables, theme: Theme): unknown {
  if (Array.isArray(value)) return value.map((v) => bakeVariables(v, variables, theme));
  if (typeof value !== "object" || value === null) return value;
  const node = value as Record<string, unknown>;
  const here = isTheme(node.theme) ? { ...theme, ...node.theme } : theme;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(node)) {
    if (typeof v === "string") {
      out[key] = LITERAL_KEYS.has(key) || !VARIABLE_REF.test(v) ? v : resolveReference(v, variables, here);
    } else {
      out[key] = key === "theme" ? v : bakeVariables(v, variables, here);
    }
  }
  return out;
}

/** Axis defaults: the first value of each declared theme axis. */
export function defaultTheme(themes: PenThemes | undefined): Theme {
  return Object.fromEntries(Object.entries(themes ?? {}).flatMap(([axis, values]) => (values[0] ? [[axis, values[0]]] : [])));
}

/**
 * Copy of `doc` for OpenPencil with `theme` pinned on the frame and every variable reference
 * resolved for the theme in effect. The caller's document is never mutated.
 */
export function prepareDocument(doc: PenDocument, frameId: string, theme?: Theme): PenDocument {
  const copy = withFrameTheme(doc, frameId, theme && findNode(doc.children, frameId) ? theme : undefined);
  const variables = copy.variables ?? {};
  const children = bakeVariables(copy.children, variables, defaultTheme(copy.themes)) as PenNode[];
  return { ...copy, children };
}
