import type { PenFill, PenFillObject, PenGradientStop } from "./types.js";

const GRADIENT_TYPES = new Set(["gradient", "linear_gradient", "radial_gradient", "linear", "radial"]);

/** The visible paint on top: the last enabled entry of a fill list. */
function topPaint(fill: unknown): string | PenFillObject | undefined {
  const list = Array.isArray(fill) ? fill : [fill];
  const visible = list.filter((p) => typeof p === "string" || (typeof p === "object" && p !== null && (p as PenFillObject).enabled !== false));
  return visible.at(-1) as string | PenFillObject | undefined;
}

/**
 * The colour ("#hex" or "$var") of a solid fill, or undefined when the top paint is not solid
 * (gradient, image, unknown form, missing or disabled).
 */
export function solidColor(fill: PenFill | undefined): string | undefined {
  const paint = topPaint(fill);
  if (typeof paint === "string") return paint;
  if (!paint || typeof paint.color !== "string") return undefined;
  if (paint.type !== undefined && paint.type !== "color" && paint.type !== "solid") return undefined;
  return paint.color;
}

/** The colour stops of a gradient fill, or undefined when the top paint is not a gradient. */
export function gradientStops(fill: PenFill | undefined): PenGradientStop[] | undefined {
  const paint = topPaint(fill);
  if (typeof paint !== "object" || paint === null || !GRADIENT_TYPES.has(String(paint.type))) return undefined;
  const stops = Array.isArray(paint.stops) ? paint.stops : Array.isArray(paint.colors) ? paint.colors : undefined;
  if (!stops) return undefined;
  return stops.filter((s): s is PenGradientStop => typeof s === "object" && s !== null && typeof s.color === "string");
}
