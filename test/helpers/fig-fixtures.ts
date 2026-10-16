import { readFileSync } from "node:fs";
import { type Fill, SceneGraph, type SceneNode } from "@open-pencil/core";
import { exportFigFile } from "@open-pencil/core/io/formats/fig";

/** Directory of the committed `.fig` fixtures and the PNGs their image fills embed. */
export const FIG_FIXTURES_DIR = new URL("../../../fixtures/fig/", import.meta.url);

export type FigSide = "base" | "head";

export interface FigFixture {
  /** Directory name under `fixtures/fig/`; holds `base.fig` and `head.fig`. */
  name: string;
  build(side: FigSide): SceneGraph;
}

const solid = (r: number, g: number, b: number, a = 1): Fill => ({ type: "SOLID", color: { r, g, b, a }, opacity: a, visible: true });
const RED = solid(1, 0, 0);
const BLUE = solid(0, 0, 1);
const WHITE: Fill["color"] = { r: 1, g: 1, b: 1, a: 1 };
const NEAR_BLACK: Fill["color"] = { r: 0.07, g: 0.07, b: 0.07, a: 1 };

/** A graph with one page whose layers get fixed ids `1:<n>`, so regenerating never changes an id; generated ids start above them. */
class Builder {
  readonly graph: SceneGraph;
  readonly page: SceneNode;
  private counter = 0;

  constructor() {
    this.graph = new SceneGraph(() => `1:${++this.counter}`);
    this.page = this.graph.getPages()[0]!;
    this.counter = 999;
  }

  /** Fixed id for layer number `n` (always `1:<100 + n>`). */
  id(n: number): string {
    return `1:${100 + n}`;
  }

  add(n: number, type: SceneNode["type"], parent: SceneNode, props: Partial<SceneNode>): SceneNode {
    return this.graph.createNodeWithId(this.id(n), type, parent.id, props);
  }
}

function solidFill(side: FigSide): SceneGraph {
  const b = new Builder();
  const frame = b.add(1, "FRAME", b.page, { name: "Card", width: 120, height: 80 });
  b.add(2, "RECTANGLE", frame, { name: "Box", x: 10, y: 10, width: 60, height: 40, fills: [side === "base" ? RED : BLUE] });
  return b.graph;
}

function movedNode(side: FigSide): SceneGraph {
  const b = new Builder();
  const frame = b.add(1, "FRAME", b.page, { name: "Canvas", width: 200, height: 120 });
  const at = side === "base" ? { x: 10, y: 10 } : { x: 90, y: 50 };
  b.add(2, "RECTANGLE", frame, { name: "Mover", ...at, width: 40, height: 40, fills: [RED] });
  return b.graph;
}

function textChange(side: FigSide): SceneGraph {
  const b = new Builder();
  const frame = b.add(1, "FRAME", b.page, { name: "Title card", width: 200, height: 60 });
  b.add(2, "TEXT", frame, {
    name: "Title",
    x: 8,
    y: 8,
    width: 180,
    height: 24,
    text: side === "base" ? "Hello" : "Hello world",
    fontSize: 16,
    fontFamily: "Inter",
    fills: [solid(0, 0, 0)],
  });
  return b.graph;
}

function frameAddRemove(side: FigSide): SceneGraph {
  const b = new Builder();
  const names = side === "base" ? ["Alpha", "Beta"] : ["Beta", "Gamma"];
  const ids = { Alpha: 1, Beta: 2, Gamma: 3 };
  names.forEach((name, i) => {
    const frame = b.add(ids[name as keyof typeof ids], "FRAME", b.page, { name, x: i * 140, y: 0, width: 120, height: 80 });
    b.add(ids[name as keyof typeof ids] + 10, "RECTANGLE", frame, { name: `${name} box`, x: 10, y: 10, width: 40, height: 40, fills: [RED] });
  });
  return b.graph;
}

/** A "Theme" collection with Light and Dark modes and a `bg` colour, which a frame binds as its fill. */
function themed(side: FigSide, change: "mode" | "value"): SceneGraph {
  const b = new Builder();
  const g = b.graph;
  const collection = g.createCollection("Theme");
  const light = collection.defaultModeId;
  g.renameMode(collection.id, light, "Light");
  const dark = g.createMode(collection.id, "Dark")!;
  const bg = g.createVariable("bg", "COLOR", collection.id, WHITE);
  const lightBg = change === "value" && side === "head" ? { r: 0.98, g: 0.98, b: 0.98, a: 1 } : WHITE;
  bg.valuesByMode = { [light]: lightBg, [dark]: NEAR_BLACK };
  const mode = change === "mode" && side === "head" ? dark : light;
  const screen = b.add(1, "FRAME", b.page, { name: "Screen", width: 120, height: 80, fills: [{ ...solid(1, 1, 1) }], variableModes: { [collection.id]: mode } });
  g.bindVariable(screen.id, "fills/0/color", bg.id);
  return g;
}

function instanceOverride(side: FigSide): SceneGraph {
  const b = new Builder();
  const g = b.graph;
  const component = b.add(1, "COMPONENT", b.page, { name: "Button", x: 0, y: 0, width: 100, height: 32, fills: [BLUE] });
  b.add(2, "TEXT", component, { name: "Label", x: 8, y: 6, width: 84, height: 20, text: "Click", fontSize: 14, fontFamily: "Inter", fills: [solid(1, 1, 1)] });
  const screen = b.add(3, "FRAME", b.page, { name: "Screen", x: 160, y: 0, width: 200, height: 100 });
  const instance = g.createInstance(component.id, screen.id, { name: "Primary button", x: 20, y: 20 })!;
  if (side === "head") {
    const label = g.getChildren(instance.id)[0]!;
    g.updateNode(label.id, { text: "Pay now" });
    instance.instanceOverrides.descendants.set(label.id, new Map([["text", "Pay now"]]));
    g.updateNode(instance.id, { instanceOverrides: instance.instanceOverrides });
  }
  return g;
}

function imageFill(side: FigSide): SceneGraph {
  const b = new Builder();
  const png = new Uint8Array(readFileSync(new URL(`images/pixel-${side === "base" ? "a" : "b"}.png`, FIG_FIXTURES_DIR)));
  const hash = `${side === "base" ? "a" : "b"}`.repeat(40);
  b.graph.images.set(hash, png);
  const frame = b.add(1, "FRAME", b.page, { name: "Photo card", width: 120, height: 80 });
  b.add(2, "RECTANGLE", frame, {
    name: "Photo",
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    fills: [{ type: "IMAGE", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, imageHash: hash, imageScaleMode: "FILL" }],
  });
  return b.graph;
}

export const FIG_FIXTURES: readonly FigFixture[] = [
  { name: "solid-fill", build: solidFill },
  { name: "moved-node", build: movedNode },
  { name: "text-change", build: textChange },
  { name: "frame-add-remove", build: frameAddRemove },
  { name: "variable-mode", build: (side) => themed(side, "mode") },
  { name: "variable-value", build: (side) => themed(side, "value") },
  { name: "instance-override", build: instanceOverride },
  { name: "image-fill", build: imageFill },
];

const FIXED_NOW = Date.UTC(2020, 0, 1);

/**
 * Writes `graph` with OpenPencil's own `.fig` writer (the zip archive Figma saves). The writer
 * stamps meta.json with the current time, so the clock is pinned for the call to keep the bytes
 * reproducible. The thumbnail is the writer's built-in 1x1 PNG: no CanvasKit is needed for it.
 */
export async function writeFig(graph: SceneGraph): Promise<Uint8Array> {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args: [] | [number | string | Date]) {
      if (args.length === 0) super(FIXED_NOW);
      else super(args[0]);
    }
    static override now(): number {
      return FIXED_NOW;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await exportFigFile(graph);
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Path of a fixture file relative to the repo root. */
export const figFixturePath = (name: string, side: FigSide): string => `fixtures/fig/${name}/${side}.fig`;

/** A stable JSON serialization of every node, variable and image of a parsed graph (maps and byte arrays included). */
export function stableGraph(graph: SceneGraph): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Map) return { map: [...value.entries()] };
    if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
    return value;
  };
  return JSON.stringify(
    {
      nodes: [...graph.getAllNodes()],
      collections: [...graph.variableCollections.values()],
      variables: [...graph.variables.values()],
      images: [...graph.images.entries()],
      version: graph.figKiwiVersion,
    },
    replacer,
    1,
  );
}
