import type { SceneNode } from "@open-pencil/core";
import type { PenNode } from "../pen/types.js";
import { type FigContext, figNodeId, penProps } from "./props.js";

/**
 * The `.pen` properties a Figma instance-override field stands for. An override is recorded per
 * field name; a field with no entry here is not mapped (it is left out, as on every other node).
 */
const OVERRIDE_PROPS: Record<string, readonly string[]> = {
  text: ["content"],
  styleRuns: ["styleRuns"],
  fills: ["fill"],
  strokes: ["stroke"],
  effects: ["effect"],
  visible: ["enabled"],
  opacity: ["opacity"],
  cornerRadius: ["cornerRadius"],
  topLeftRadius: ["cornerRadius"],
  topRightRadius: ["cornerRadius"],
  bottomLeftRadius: ["cornerRadius"],
  bottomRightRadius: ["cornerRadius"],
  fontSize: ["fontSize"],
  fontFamily: ["fontFamily"],
  fontWeight: ["fontWeight"],
  italic: ["fontStyle"],
  lineHeight: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  textAlignHorizontal: ["textAlign"],
  textAlignVertical: ["textAlignVertical"],
  textCase: ["textTransform"],
  textDecoration: ["textDecoration"],
  clipsContent: ["clip"],
  layoutMode: ["layout"],
  itemSpacing: ["gap"],
  paddingTop: ["padding"],
  paddingRight: ["padding"],
  paddingBottom: ["padding"],
  paddingLeft: ["padding"],
  primaryAxisAlign: ["justifyContent"],
  counterAxisAlign: ["alignItems"],
  x: ["x"],
  y: ["y"],
  width: ["width"],
  height: ["height"],
  rotation: ["rotation"],
};

/** `.pen` properties named by the override fields of one sublayer (a bound variable counts as its field). */
function overriddenProps(fields: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const field of fields) {
    const own = field.startsWith("boundVariables/") ? field.slice("boundVariables/".length) : field;
    for (const prop of OVERRIDE_PROPS[own.split("/")[0]!] ?? []) out.add(prop);
  }
  return out;
}

function pick(props: Record<string, unknown>, keys: Set<string>): Record<string, unknown> {
  return Object.fromEntries([...keys].filter((k) => k in props).map((k) => [k, props[k]]));
}

/** The nodes a component's own subtree has under `node`; a nested instance shows the children of its main component. */
function componentChildren(ctx: FigContext, node: SceneNode): SceneNode[] {
  const source = node.type === "INSTANCE" && node.componentId !== null ? (ctx.graph.getNode(node.componentId) ?? node) : node;
  return ctx.graph.getChildren(source.id).filter((c) => !c.internalOnly);
}

/**
 * The `descendants` overrides of an instance, keyed by the "/"-joined ids of the component's own
 * nodes (what the compiler resolves), plus the count of overridden sublayers that have no
 * counterpart in the component (added or removed layers), which cannot be addressed.
 */
function descendantOverrides(ctx: FigContext, instance: SceneNode, component: SceneNode): { descendants: Record<string, Partial<PenNode>>; unmapped: number } {
  const descendants: Record<string, Partial<PenNode>> = {};
  let unmapped = 0;
  const walk = (inst: SceneNode, comp: SceneNode, path: string[]): void => {
    const instKids = ctx.graph.getChildren(inst.id).filter((c) => !c.internalOnly);
    const compKids = componentChildren(ctx, comp);
    if (instKids.length !== compKids.length) unmapped++;
    instKids.forEach((kid, i) => {
      const counterpart = compKids[i];
      if (!counterpart) return;
      const at = [...path, figNodeId(counterpart, ctx.guids)];
      const fields = instance.instanceOverrides.descendants.get(kid.id);
      if (fields) {
        const props = pick(penProps(ctx, kid), overriddenProps(fields.keys()));
        if (Object.keys(props).length > 0) descendants[at.join("/")] = props;
      }
      walk(kid, counterpart, at);
    });
  };
  walk(instance, component, []);
  return { descendants, unmapped };
}

/**
 * An instance as a `ref` to its component: its own position, the properties it overrides on
 * itself and its size when it differs from the component's, plus `descendants` for sublayers.
 * Undefined when the main component is not in the file (the caller keeps the instance as a frame).
 */
export function penInstance(ctx: FigContext, instance: SceneNode): Partial<PenNode> | undefined {
  const component = instance.componentId === null ? undefined : ctx.graph.getNode(instance.componentId);
  if (component?.type !== "COMPONENT") return undefined;
  const own = penProps(ctx, instance);
  const keys = overriddenProps(instance.instanceOverrides.self.keys());
  keys.add("x").add("y");
  if (instance.width !== component.width) keys.add("width");
  if (instance.height !== component.height) keys.add("height");
  const { descendants, unmapped } = descendantOverrides(ctx, instance, component);
  return {
    ref: figNodeId(component, ctx.guids),
    ...pick(own, keys),
    ...(Object.keys(descendants).length > 0 ? { descendants } : {}),
    ...(unmapped > 0 ? { figUnmappedOverrides: unmapped } : {}),
  };
}
