/** Version string of a `.pen` document, e.g. "2.6". */
export type PenVersion = string;

/** A single variable definition; the value may differ per theme. */
export interface PenVariable {
  type: string;
  value: unknown;
}

/** Theme axes: axis name -> allowed values, e.g. { mode: ["light", "dark"] }. */
export type PenThemes = Record<string, string[]>;

export type PenVariables = Record<string, PenVariable>;

export interface PenNode {
  id: string;
  type: string;
  name?: string;
  children?: PenNode[];
  /** Id of the reusable node this instance refers to. */
  ref?: string;
  /** Per-path overrides applied to an instance's subtree. */
  descendants?: Record<string, Partial<PenNode>>;
  reusable?: boolean;
  /** Theme selection pinned on this node, inherited by its subtree. */
  theme?: Record<string, string>;
  [key: string]: unknown;
}

export interface PenDocument {
  version: PenVersion;
  children: PenNode[];
  variables?: PenVariables;
  themes?: PenThemes;
}

/*
 * Paint shapes, matched to the OpenPencil 0.16.0 importer
 * (@open-pencil/pen src/convert.ts: PenFillObject :67, PenFill :73, PenStroke :50, PenEffect :58,
 * convertFill :292, convertStroke :314, convertEffects :357). The importer only understands solid
 * paints: a "#hex"/"$var" string or an object with `color` (and `enabled`), alone or in an array
 * (the last visible entry is on top). It also reads a stroke's `fill` as a plain colour string and
 * only `type: "shadow"` effects. Gradient and image fills are not imported; they are typed here
 * as extra object forms so rules can classify them, and are treated as `unknown` paints.
 */

/** A colour: "#RGB"/"#RRGGBB"/"#RRGGBBAA" or a "$variable" reference. */
export type PenColor = string;

export interface PenGradientStop {
  color: PenColor;
  /** 0..1 along the gradient. */
  position?: number;
}

export interface PenFillObject {
  type?: string;
  color?: PenColor;
  enabled?: boolean;
  /** Gradient stops (not imported by OpenPencil 0.16.0). */
  stops?: PenGradientStop[];
  /** Alternate spelling of `stops`. */
  colors?: PenGradientStop[];
  [key: string]: unknown;
}

export type PenFill = PenColor | PenFillObject | PenFillObject[];

export interface PenStroke {
  align?: "inside" | "center" | "outside";
  thickness?: number | { top?: number; right?: number; bottom?: number; left?: number };
  fill?: PenColor;
  join?: string;
  cap?: string;
}

export interface PenEffect {
  type: string;
  shadowType?: string;
  color?: PenColor;
  offset?: { x: number; y: number };
  blur?: number;
  spread?: number;
}
