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
