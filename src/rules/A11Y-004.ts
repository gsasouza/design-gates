import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import type { Rule, Violation } from "../gates/types.js";
import type { Theme } from "../render/themes.js";
import { definitionOf, fromComponent } from "./A11Y-001.js";
import { ancestorsOf, hasVisiblePaint, isObject, opacityAbove, resolveValue, walkBackground } from "./a11y/background.js";
import { parseColor } from "./a11y/color.js";

const ID = "A11Y-004";
/** Effective alpha a solid layer needs to count as a scrim. */
const SCRIM_ALPHA = 0.3;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const IMAGE_LIKE: Record<string, string> = { image: "an image", mesh_gradient: "a mesh gradient", shader: "a shader" };
const BLUR = "a background blur";

type Layer = { kind: "image"; label: string } | { kind: "solid"; alpha: number } | { kind: "other" };

/** A node's fill entries as layers, topmost first (the last array entry is on top). */
function fillLayers(compiled: CompiledDocument, node: CompiledNode, theme: Theme): Layer[] {
  const raw = node.props.fill;
  const list = (Array.isArray(raw) ? raw : [raw]).filter((p) => (typeof p === "string" ? true : isObject(p) && p.enabled !== false));
  return list.reverse().map((p): Layer => {
    const type = isObject(p) && typeof p.type === "string" ? p.type : undefined;
    if (type !== undefined && IMAGE_LIKE[type] !== undefined) return { kind: "image", label: IMAGE_LIKE[type]! };
    const solid = typeof p === "string" ? p : isObject(p) && (type === undefined || type === "color" || type === "solid") ? p.color : undefined;
    const c = parseColor(resolveValue(compiled, solid, theme));
    return c ? { kind: "solid", alpha: c.a } : { kind: "other" };
  });
}

/** True when the node declares a `background_blur` effect (one effect or a list, under `effect` or `effects`). */
function hasBackgroundBlur(node: CompiledNode): boolean {
  return [node.props.effect, node.props.effects].flat().some((e) => isObject(e) && e.type === "background_blur" && e.enabled !== false);
}

interface Found {
  label: string;
  scrim: boolean;
  /** Ancestors (nearest first) the walk went through, up to the image-like layer. */
  used: CompiledNode[];
}

/**
 * Walks the background of a text node from the text upward. Within one node the layers are
 * the fill entries from last (top) to first, then the `background_blur` backdrop, which blurs what is behind the node.
 */
function find(compiled: CompiledDocument, text: CompiledNode, chain: CompiledNode[], theme: Theme): Found | undefined {
  const above = opacityAbove(compiled, text, chain, theme);
  const used: CompiledNode[] = [];
  let scrim = false;
  let found: Found | undefined;
  let done = false;
  walkBackground(chain, above, (a, factor) => {
    used.push(a);
    for (const layer of fillLayers(compiled, a, theme)) {
      if (layer.kind === "image") {
        found = { label: layer.label, scrim, used: [...used] };
        return (done = true);
      }
      if (layer.kind !== "solid") continue;
      const alpha = layer.alpha * factor;
      if (alpha >= 1) return (done = true);
      if (alpha >= SCRIM_ALPHA) scrim = true;
    }
    if (hasBackgroundBlur(a)) {
      found = { label: BLUR, scrim, used: [...used] };
      return (done = true);
    }
    return false;
  });
  return done ? found : undefined;
}

/** True when the text, the image-like layer and everything between them come from one component. */
function selfContained(text: CompiledNode, chain: CompiledNode[], used: CompiledNode[]): boolean {
  if (!text.expanded) return false;
  const rootIndex = chain.findIndex((a) => a.instanceOf !== undefined);
  if (rootIndex < 0) return false;
  const inside = [text, ...chain.slice(0, rootIndex + 1)];
  if (!inside.every((n) => fromComponent(n, "fill") && fromComponent(n, "opacity") && fromComponent(n, "effect") && fromComponent(n, "effects"))) return false;
  if (!used.every((a) => inside.includes(a))) return false;
  return chain.slice(rootIndex + 1).every((a) => a.props.opacity === undefined || a.props.opacity === 1);
}

export const runA11y004: Rule = (compiled, config: GatesConfig) => {
  const requireScrim = config.rules[ID].requireScrim;
  const out: Violation[] = [];
  const pending: { key: string; v: Violation; instance: string }[] = [];

  for (const text of compiled.nodes) {
    if (text.type !== "text" || !hasVisiblePaint(text.props.fill)) continue;
    const chain = ancestorsOf(compiled, text);
    const found = find(compiled, text, chain, text.theme);
    if (!found || found.scrim) continue;
    const v: Violation = {
      rule: ID,
      file: compiled.file,
      nodeId: text.id,
      path: text.path,
      prop: "fill",
      severity: requireScrim ? "warn" : "review",
      ...(requireScrim ? {} : { fixedSeverity: true }),
      message: `text sits over ${found.label} with no scrim; contrast cannot be guaranteed`,
    };
    const def = selfContained(text, chain, found.used) ? definitionOf(compiled, text) : undefined;
    const instance = [...chain].reverse().find((a) => !a.expanded && a.instanceOf !== undefined);
    if (def && instance) pending.push({ key: `${def.id}\u0000${v.message}`, v, instance: instance.id });
    else out.push(v);
  }

  // report component-owned results once, on the component, with the instances they affect
  const reported = new Map<string, Violation>();
  for (const v of out) reported.set(`${v.nodeId}\u0000${v.message}`, v);
  const attach = new Map<string, Set<string>>();
  for (const p of pending) {
    if (!reported.has(p.key)) {
      out.push(p.v);
      continue;
    }
    const set = attach.get(p.key) ?? new Set<string>();
    set.add(p.instance);
    attach.set(p.key, set);
  }
  for (const [key, ids] of attach) reported.get(key)!.affectedInstances = [...ids].sort(byString);
  return out.sort((a, b) => byString(a.nodeId, b.nodeId) || byString(a.prop ?? "", b.prop ?? ""));
};
