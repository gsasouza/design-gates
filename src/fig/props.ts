import type { LayoutAlign, LayoutCounterAlign, NodeType, SceneGraph, SceneNode } from "@open-pencil/core";
import type { PenNode } from "../pen/types.js";
import { penEffect, penFill, penStroke, type VariableNames } from "./paint.js";
import type { FigVariables } from "./variables.js";

export interface FigContext {
  graph: SceneGraph;
  names: VariableNames;
  pin: FigVariables["pin"];
  /** Figma GUIDs by graph node id, for nodes whose own `source.id` is missing. */
  guids: ReadonlyMap<string, string>;
  /** When set, receives a `[doc id, graph id]` pair for every node the normalizer emits. */
  emitted?: Array<[string, string]>;
}

/** Stable id of a scene node: its Figma GUID, which survives sibling reordering (graph ids are assigned by file order). */
export function figNodeId(node: SceneNode, guids?: ReadonlyMap<string, string>): string {
  return node.source.id ?? guids?.get(node.id) ?? node.id;
}

/** The `.pen` type of every Figma node type, and whether the node is only an approximation of it (then it carries `figType`). */
export const PEN_TYPES: Record<NodeType, { type: string; exact: boolean }> = {
  CANVAS: { type: "frame", exact: false },
  FRAME: { type: "frame", exact: true },
  GROUP: { type: "group", exact: true },
  RECTANGLE: { type: "rectangle", exact: true },
  ELLIPSE: { type: "ellipse", exact: true },
  TEXT: { type: "text", exact: true },
  INSTANCE: { type: "ref", exact: true },
  COMPONENT: { type: "frame", exact: true },
  ROUNDED_RECTANGLE: { type: "rectangle", exact: false },
  LINE: { type: "line", exact: false },
  STAR: { type: "path", exact: false },
  POLYGON: { type: "polygon", exact: false },
  VECTOR: { type: "path", exact: false },
  BOOLEAN_OPERATION: { type: "path", exact: false },
  SECTION: { type: "frame", exact: false },
  COMPONENT_SET: { type: "frame", exact: false },
  CONNECTOR: { type: "line", exact: false },
  SHAPE_WITH_TEXT: { type: "frame", exact: false },
};

const JUSTIFY: Record<LayoutAlign, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space_between" };
const ALIGN: Record<LayoutCounterAlign, string> = { MIN: "start", CENTER: "center", MAX: "end", STRETCH: "stretch", BASELINE: "baseline" };
const TEXT_ALIGN = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justified" } as const;
const TEXT_GROWTH = { NONE: "fixed-width-height", HEIGHT: "fixed-width", WIDTH_AND_HEIGHT: "auto", TRUNCATE: "truncate" } as const;
const FRAME_LIKE = new Set<NodeType>(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "INSTANCE", "SHAPE_WITH_TEXT"]);

/** A number, or the `$variable` a Figma variable binding on `field` names. */
function bound(node: SceneNode, field: string, names: VariableNames, literal: number): number | string {
  const id = node.boundVariables[field];
  const name = id === undefined ? undefined : names.get(id);
  return name === undefined ? literal : `$${name}`;
}

function paddingOf(node: SceneNode, names: VariableNames): PenNode["padding"] {
  const [t, r, b, l] = [
    bound(node, "paddingTop", names, node.paddingTop),
    bound(node, "paddingRight", names, node.paddingRight),
    bound(node, "paddingBottom", names, node.paddingBottom),
    bound(node, "paddingLeft", names, node.paddingLeft),
  ];
  if (t === 0 && r === 0 && b === 0 && l === 0) return undefined;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return [t, r];
  return [t, r, b, l];
}

function cornerRadiusOf(node: SceneNode, names: VariableNames): unknown {
  if (node.independentCorners) {
    return [
      bound(node, "topLeftRadius", names, node.topLeftRadius),
      bound(node, "topRightRadius", names, node.topRightRadius),
      bound(node, "bottomRightRadius", names, node.bottomRightRadius),
      bound(node, "bottomLeftRadius", names, node.bottomLeftRadius),
    ];
  }
  const radius = bound(node, "cornerRadius", names, node.cornerRadius);
  return radius === 0 ? undefined : radius;
}

function layoutProps(node: SceneNode, names: VariableNames): Record<string, unknown> {
  if (node.layoutMode === "NONE") return { layout: "none" };
  if (node.layoutMode === "GRID") return { layout: "grid" };
  return {
    layout: node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical",
    gap: bound(node, "itemSpacing", names, node.itemSpacing),
    padding: paddingOf(node, names),
    justifyContent: JUSTIFY[node.primaryAxisAlign],
    alignItems: ALIGN[node.counterAxisAlign],
    ...(node.layoutWrap === "WRAP" ? { wrap: true } : {}),
  };
}

function textProps(node: SceneNode, names: VariableNames): Record<string, unknown> {
  const family = node.boundVariables.fontFamily === undefined ? undefined : names.get(node.boundVariables.fontFamily);
  return {
    content: node.text,
    fontFamily: family === undefined ? node.fontFamily : `$${family}`,
    fontSize: bound(node, "fontSize", names, node.fontSize),
    fontWeight: node.fontWeight,
    ...(node.italic ? { fontStyle: "italic" } : {}),
    ...(node.lineHeight !== null ? { lineHeight: node.lineHeight } : {}),
    ...(node.letterSpacing !== 0 ? { letterSpacing: node.letterSpacing } : {}),
    textAlign: TEXT_ALIGN[node.textAlignHorizontal],
    textAlignVertical: node.textAlignVertical.toLowerCase(),
    textGrowth: TEXT_GROWTH[node.textAutoResize],
    ...(node.textDecoration !== "NONE" ? { textDecoration: node.textDecoration.toLowerCase() } : {}),
    ...(node.textCase !== "ORIGINAL" ? { textTransform: node.textCase.toLowerCase() } : {}),
    // Mixed styles inside one text: kept as the raw run list, so a change to any run is a change.
    ...(node.styleRuns.length > 0 ? { styleRuns: node.styleRuns } : {}),
  };
}

/** Every `.pen` property a Figma node maps to (no id, type, name, children or instance links). */
export function penProps(ctx: FigContext, node: SceneNode): Record<string, unknown> {
  const { names } = ctx;
  const props: Record<string, unknown> = {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.rotation !== 0 ? { rotation: node.rotation } : {}),
    ...(!node.visible ? { enabled: false } : {}),
    ...(node.opacity !== 1 ? { opacity: bound(node, "opacity", names, node.opacity) } : {}),
    ...(node.clipsContent ? { clip: true } : {}),
    cornerRadius: cornerRadiusOf(node, names),
    fill: penFill(node, names),
    stroke: penStroke(node, names),
    effect: penEffect(node),
    theme: ctx.pin(node.variableModes),
  };
  if (FRAME_LIKE.has(node.type)) Object.assign(props, layoutProps(node, names));
  if (node.type === "TEXT") Object.assign(props, textProps(node, names));
  for (const key of Object.keys(props)) if (props[key] === undefined) delete props[key];
  return props;
}
