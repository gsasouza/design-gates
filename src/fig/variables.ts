import type { SceneGraph, Variable, VariableValue } from "@open-pencil/core";
import type { PenThemes, PenVariable, PenVariables } from "../pen/types.js";
import { hexColor, type VariableNames } from "./paint.js";

export interface FigVariables {
  /** Pen name of each variable, by Figma variable id. */
  names: VariableNames;
  variables: PenVariables;
  themes: PenThemes;
  /** A node's explicit variable-mode selection as a `.pen` theme pin, or undefined when it selects none. */
  pin(modes: Record<string, string>): Record<string, string> | undefined;
}

/** `name`, or `name-2`, `name-3` ... for the later ones, so duplicates stay distinct in a deterministic order. */
function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** A `$name` reference cannot hold whitespace or another `$`, so those become `-`. */
const refSafe = (name: string): string => name.replace(/[\s$]+/g, "-");

const PEN_TYPES = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" } as const;

function penValue(value: VariableValue, names: VariableNames): unknown {
  if (typeof value === "object" && "aliasId" in value) {
    const target = names.get(value.aliasId);
    return target === undefined ? undefined : `$${target}`;
  }
  if (typeof value === "object") return hexColor(value);
  return value;
}

/** Each collection's theme axis name and its modes' names (by mode id), deduplicated the way the normalizer names them. */
/** Each collection's theme axis and its modes' names (by mode id), deduplicated the way the normalizer names them. */
export function figAxes(graph: SceneGraph): { axes: Map<string, { axis: string; modes: Map<string, string> }>; themes: PenThemes } {
  const axisTaken = new Set<string>();
  const axes = new Map<string, { axis: string; modes: Map<string, string> }>();
  const themes: PenThemes = {};
  for (const collection of graph.variableCollections.values()) {
    const axis = uniqueName(collection.name, axisTaken);
    const modeTaken = new Set<string>();
    const modes = new Map(collection.modes.map((m) => [m.modeId, uniqueName(m.name, modeTaken)]));
    axes.set(collection.id, { axis, modes });
    themes[axis] = [...modes.values()];
  }
  return { axes, themes };
}

/**
 * Figma variables as `.pen` variables and their collections as theme axes: the axis is the
 * collection name and its values are the mode names; a variable is named `<collection>/<name>`.
 */
export function figVariables(graph: SceneGraph): FigVariables {
  const { axes, themes } = figAxes(graph);

  const taken = new Set<string>();
  const names = new Map<string, string>();
  const ordered: Variable[] = [];
  for (const variable of graph.variables.values()) {
    const axis = axes.get(variable.collectionId)?.axis ?? "";
    names.set(variable.id, uniqueName(refSafe(`${axis}/${variable.name}`), taken));
    ordered.push(variable);
  }

  const variables: PenVariables = {};
  for (const variable of ordered) {
    const axis = axes.get(variable.collectionId);
    if (!axis) continue;
    const value = [...axis.modes].flatMap(([modeId, modeName]) => {
      const raw = variable.valuesByMode[modeId];
      const resolved = raw === undefined ? undefined : penValue(raw, names);
      return resolved === undefined ? [] : [{ value: resolved, theme: { [axis.axis]: modeName } }];
    });
    const entry: PenVariable = { type: PEN_TYPES[variable.type], value };
    variables[names.get(variable.id)!] = entry;
  }

  const pin = (modes: Record<string, string>): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [collectionId, modeId] of Object.entries(modes)) {
      const axis = axes.get(collectionId);
      const mode = axis?.modes.get(modeId);
      if (axis && mode) out[axis.axis] = mode;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  return { names, variables, themes, pin };
}
