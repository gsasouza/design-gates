import type { Effect, Fill, SceneNode, Stroke } from "@open-pencil/core";
import type { PenEffect, PenFill, PenFillObject, PenStroke } from "../pen/types.js";

/** Names of the Figma variables a node binds, by variable id (the pen name, without the `$`). */
export type VariableNames = ReadonlyMap<string, string>;

type Rgba = { r: number; g: number; b: number; a: number };

const byte = (v: number): string =>
  Math.min(255, Math.max(0, Math.round(v * 255)))
    .toString(16)
    .padStart(2, "0");

/** "#rrggbb", or "#rrggbbaa" when the alpha is not fully opaque, as `.pen` writes colours. */
export function hexColor(c: Rgba, opacity = 1): string {
  const alpha = Math.min(1, Math.max(0, c.a * opacity));
  const a = byte(alpha);
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${a === "ff" ? "" : a}`;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

const GRADIENT_KINDS: Record<string, string> = {
  GRADIENT_LINEAR: "linear",
  GRADIENT_RADIAL: "radial",
  GRADIENT_ANGULAR: "angular",
  GRADIENT_DIAMOND: "diamond",
};

/** A paint as a `.pen` colour (a "#hex" or "$var" string), or the object form when it carries more than a colour. */
function paintValue(paint: Fill, node: SceneNode, names: VariableNames, index: number, field: "fills" | "strokes"): PenFillObject | string {
  const variable = node.boundVariables[`${field}/${index}/color`];
  const name = variable === undefined ? undefined : names.get(variable);
  const color = name !== undefined ? `$${name}` : hexColor(paint.color, paint.opacity);
  const base = paint.blendMode !== undefined && paint.blendMode !== "NORMAL" ? { blendMode: paint.blendMode } : {};

  if (paint.type === "SOLID") {
    if (paint.visible && Object.keys(base).length === 0) return color;
    return { type: "color", color, ...(paint.visible ? {} : { enabled: false }), ...base };
  }
  const common: PenFillObject = { ...(paint.visible ? {} : { enabled: false }), ...base, ...(paint.opacity !== 1 ? { opacity: round(paint.opacity) } : {}) };
  const kind = GRADIENT_KINDS[paint.type];
  if (kind) {
    const t = paint.gradientTransform;
    return {
      type: "gradient",
      gradientType: kind,
      stops: (paint.gradientStops ?? []).map((s) => ({ color: hexColor(s.color), position: round(s.position) })),
      ...(t ? { transform: [t.m00, t.m01, t.m02, t.m10, t.m11, t.m12].map(round) } : {}),
      ...common,
    };
  }
  if (paint.type === "IMAGE") {
    return { type: "image", imageHash: paint.imageHash ?? "", scaleMode: paint.imageScaleMode ?? "FILL", ...common };
  }
  return { type: "unsupported", paintType: paint.type, ...common };
}

/** The `fill` of a node: one paint as itself, several as a list (bottom to top, like `.pen`), none as undefined. */
export function penFill(node: SceneNode, names: VariableNames): PenFill | undefined {
  const paints = node.fills.map((p, i) => paintValue(p, node, names, i, "fills"));
  if (paints.length === 0) return undefined;
  // `.pen` lists may mix "#hex"/"$var" strings and paint objects, the last visible entry on top.
  return paints.length === 1 ? paints[0] : (paints as PenFillObject[]);
}

function oneStroke(node: SceneNode, stroke: Stroke, index: number, names: VariableNames): PenStroke {
  const paint = paintValue(stroke, node, names, index, "strokes");
  const thickness = node.independentStrokeWeights
    ? { top: node.borderTopWeight, right: node.borderRightWeight, bottom: node.borderBottomWeight, left: node.borderLeftWeight }
    : stroke.weight;
  return {
    align: stroke.align.toLowerCase() as PenStroke["align"],
    thickness,
    fill: paint,
    ...(node.strokeJoin !== "MITER" ? { join: node.strokeJoin.toLowerCase() } : {}),
    ...(node.strokeCap !== "NONE" ? { cap: node.strokeCap.toLowerCase() } : {}),
    ...(stroke.dashPattern && stroke.dashPattern.length > 0 ? { dashPattern: stroke.dashPattern } : {}),
  };
}

/** The `stroke` of a node: one stroke as an object, several as a list, none as undefined. */
export function penStroke(node: SceneNode, names: VariableNames): PenStroke | PenStroke[] | undefined {
  const strokes = node.strokes.map((s, i) => oneStroke(node, s, i, names));
  if (strokes.length === 0) return undefined;
  return strokes.length === 1 ? strokes[0] : strokes;
}

function oneEffect(effect: Effect): PenEffect {
  const enabled = effect.visible ? {} : { enabled: false };
  if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
    return {
      type: "shadow",
      shadowType: effect.type === "INNER_SHADOW" ? "inner" : "outer",
      color: hexColor(effect.color),
      offset: { x: effect.offset.x, y: effect.offset.y },
      blur: effect.radius,
      spread: effect.spread,
      ...enabled,
    };
  }
  return { type: "blur", blurType: effect.type.replace("_BLUR", "").toLowerCase(), blur: effect.radius, ...enabled };
}

/** The `effect` of a node: one effect as an object, several as a list, none as undefined. */
export function penEffect(node: SceneNode): PenEffect | PenEffect[] | undefined {
  const effects = node.effects.map(oneEffect);
  if (effects.length === 0) return undefined;
  return effects.length === 1 ? effects[0] : effects;
}
