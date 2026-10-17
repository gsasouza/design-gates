import type { SceneGraph, SceneNode } from "@open-pencil/core";
import type { PenDocument, PenNode } from "../pen/types.js";
import { penInstance } from "./instance.js";
import { type FigContext, PEN_TYPES, figNodeId, penProps } from "./props.js";
import { figVariables } from "./variables.js";

export { figNodeId } from "./props.js";

/** The `.pen` version the normalized document claims; the Figma file version is `DesignSource.figVersion`. */
export const FIG_PEN_VERSION = "2.6";

function toPenNode(ctx: FigContext, node: SceneNode): PenNode {
  const { type, exact } = PEN_TYPES[node.type];
  const base: PenNode = { id: figNodeId(node, ctx.guids), type, name: node.name, ...(exact ? {} : { figType: node.type }) };
  ctx.emitted?.push([base.id, node.id]);
  const instance = node.type === "INSTANCE" ? penInstance(ctx, node) : undefined;
  if (instance) return { ...base, ...instance };

  const children = ctx.graph
    .getChildren(node.id)
    .filter((child) => !child.internalOnly)
    .map((child) => toPenNode(ctx, child));
  return {
    ...base,
    // An instance whose component is not in the file keeps its own copy of the layers.
    ...(node.type === "INSTANCE" ? { type: "frame", figType: node.type } : {}),
    ...(node.type === "COMPONENT" ? { reusable: true } : {}),
    ...penProps(ctx, node),
    ...(children.length > 0 && { children }),
  };
}

/**
 * Normalizes a parsed `.fig` scene into a PenDocument. The top-level children are the layers of
 * every page, in page order (pages themselves are not nodes); node ids are the Figma GUIDs.
 * Figma variables become `variables`, their collections and modes `themes`. `emitted`, when given,
 * receives the `[doc id, graph id]` of every emitted node.
 */
export function figSceneToPen(graph: SceneGraph, guids: ReadonlyMap<string, string> = new Map(), emitted?: Array<[string, string]>): PenDocument {
  const { names, variables, themes, pin } = figVariables(graph);
  const ctx: FigContext = { graph, names, pin, guids, ...(emitted && { emitted }) };
  const children = graph
    .getPages()
    .flatMap((page) => graph.getChildren(page.id))
    .filter((node) => !node.internalOnly && node.sharedStyleType === null)
    .map((node) => toPenNode(ctx, node));
  return {
    version: FIG_PEN_VERSION,
    children,
    ...(Object.keys(variables).length > 0 && { variables }),
    ...(Object.keys(themes).length > 0 && { themes }),
  };
}
