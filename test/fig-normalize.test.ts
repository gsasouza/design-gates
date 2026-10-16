import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Fill, type NodeType, SceneGraph, type SceneNode } from "@open-pencil/core";
import { compile } from "../src/compile/compile.js";
import { KNOWN_TYPES } from "../src/compile/constants.js";
import { figSceneToPen } from "../src/fig/normalize.js";
import { gradientStops, solidColor } from "../src/pen/paint.js";
import type { PenNode } from "../src/pen/types.js";

const solid = (r: number, g: number, b: number, a = 1): Fill => ({ type: "SOLID", color: { r, g, b, a }, opacity: 1, visible: true });

/** A graph with one page "P" whose layers are made by `fill`; ids are `n1`, `n2` ... in creation order. */
function scene(fill: (g: SceneGraph, page: SceneNode) => void): SceneGraph {
  let n = 0;
  const g = new SceneGraph(() => `n${++n}`);
  fill(g, g.getPages()[0]!);
  return g;
}
const add = (g: SceneGraph, type: NodeType, parent: SceneNode, props: Partial<SceneNode> = {}): SceneNode => g.createNode(type, parent.id, { name: type, ...props });

/** The first normalized node named `name`. */
function pen(g: SceneGraph, name: string): PenNode {
  const walk = (nodes: PenNode[]): PenNode | undefined => {
    for (const n of nodes) {
      if (n.name === name) return n;
      const found = walk(n.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(figSceneToPen(g).children);
  assert.ok(found, `node ${name}`);
  return found;
}

interface Row {
  name: string;
  build(g: SceneGraph, page: SceneNode): void;
  /** Node to read, and the properties its PenNode must have (deep-equal on each). */
  node: string;
  expect: Record<string, unknown>;
}

const rows: Row[] = [
  { name: "FRAME -> frame", build: (g, p) => add(g, "FRAME", p, { name: "F" }), node: "F", expect: { type: "frame" } },
  { name: "GROUP -> group", build: (g, p) => add(g, "GROUP", p, { name: "G" }), node: "G", expect: { type: "group" } },
  { name: "RECTANGLE -> rectangle", build: (g, p) => add(g, "RECTANGLE", p, { name: "R" }), node: "R", expect: { type: "rectangle" } },
  { name: "ELLIPSE -> ellipse", build: (g, p) => add(g, "ELLIPSE", p, { name: "E" }), node: "E", expect: { type: "ellipse" } },
  { name: "TEXT -> text", build: (g, p) => add(g, "TEXT", p, { name: "T", text: "Hi" }), node: "T", expect: { type: "text", content: "Hi" } },
  { name: "COMPONENT -> reusable frame", build: (g, p) => add(g, "COMPONENT", p, { name: "C" }), node: "C", expect: { type: "frame", reusable: true } },
  {
    name: "size and position",
    build: (g, p) => add(g, "FRAME", p, { name: "S", x: 5, y: 6, width: 70, height: 80 }),
    node: "S",
    expect: { x: 5, y: 6, width: 70, height: 80 },
  },
  {
    name: "solid fill is #hex",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Solid", fills: [solid(1, 0, 0)] }),
    node: "Solid",
    expect: { fill: "#ff0000" },
  },
  {
    name: "solid fill alpha is #rrggbbaa",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Alpha", fills: [solid(0, 0, 1, 0.5)] }),
    node: "Alpha",
    expect: { fill: "#0000ff80" },
  },
  {
    name: "hidden solid fill is a disabled colour",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Hidden", fills: [{ ...solid(0, 1, 0), visible: false }] }),
    node: "Hidden",
    expect: { fill: { type: "color", color: "#00ff00", enabled: false } },
  },
  {
    name: "several fills are a list, bottom to top",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Two", fills: [solid(1, 0, 0), solid(0, 0, 0)] }),
    node: "Two",
    expect: { fill: ["#ff0000", "#000000"] },
  },
  {
    name: "gradient fill keeps its stops (and is not a solid)",
    build: (g, p) =>
      add(g, "RECTANGLE", p, {
        name: "Grad",
        fills: [{ type: "GRADIENT_LINEAR", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, gradientStops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }] }],
      }),
    node: "Grad",
    expect: { fill: { type: "gradient", gradientType: "linear", stops: [{ color: "#ff0000", position: 0 }, { color: "#0000ff", position: 1 }] } },
  },
  {
    name: "image fill keeps its hash",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Img", fills: [{ type: "IMAGE", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, imageHash: "abc", imageScaleMode: "FIT" }] }),
    node: "Img",
    expect: { fill: { type: "image", imageHash: "abc", scaleMode: "FIT" } },
  },
  {
    name: "stroke",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Stroked", strokes: [{ ...solid(0, 0, 0), weight: 2, align: "INSIDE" }], strokeJoin: "ROUND" }),
    node: "Stroked",
    expect: { stroke: { align: "inside", thickness: 2, fill: "#000000", join: "round" } },
  },
  {
    name: "drop shadow and blur effects",
    build: (g, p) =>
      add(g, "RECTANGLE", p, {
        name: "Fx",
        effects: [
          { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 1, y: 2 }, radius: 4, spread: 1, visible: true },
          { type: "LAYER_BLUR", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 0 }, radius: 3, spread: 0, visible: true },
        ],
      }),
    node: "Fx",
    expect: {
      effect: [
        { type: "shadow", shadowType: "outer", color: "#00000040", offset: { x: 1, y: 2 }, blur: 4, spread: 1 },
        { type: "blur", blurType: "layer", blur: 3 },
      ],
    },
  },
  {
    name: "auto layout direction, gap, padding and alignment",
    build: (g, p) =>
      add(g, "FRAME", p, { name: "Auto", layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 4, paddingBottom: 4, paddingLeft: 12, paddingRight: 12, primaryAxisAlign: "SPACE_BETWEEN", counterAxisAlign: "CENTER" }),
    node: "Auto",
    expect: { layout: "vertical", gap: 8, padding: [4, 12], justifyContent: "space_between", alignItems: "center" },
  },
  { name: "no auto layout is layout none", build: (g, p) => add(g, "FRAME", p, { name: "Free" }), node: "Free", expect: { layout: "none" } },
  { name: "uniform corner radius", build: (g, p) => add(g, "RECTANGLE", p, { name: "Round", cornerRadius: 6 }), node: "Round", expect: { cornerRadius: 6 } },
  {
    name: "independent corner radii",
    build: (g, p) => add(g, "RECTANGLE", p, { name: "Corners", independentCorners: true, topLeftRadius: 1, topRightRadius: 2, bottomRightRadius: 3, bottomLeftRadius: 4 }),
    node: "Corners",
    expect: { cornerRadius: [1, 2, 3, 4] },
  },
  {
    name: "text style",
    build: (g, p) => add(g, "TEXT", p, { name: "Styled", text: "x", fontFamily: "Inter", fontSize: 18, fontWeight: 700, italic: true, lineHeight: 24, letterSpacing: 1, textAlignHorizontal: "CENTER", textAutoResize: "HEIGHT" }),
    node: "Styled",
    expect: { fontFamily: "Inter", fontSize: 18, fontWeight: 700, fontStyle: "italic", lineHeight: 24, letterSpacing: 1, textAlign: "center", textGrowth: "fixed-width" },
  },
  { name: "opacity, rotation, hidden and clip", build: (g, p) => add(g, "FRAME", p, { name: "Misc", opacity: 0.5, rotation: 90, visible: false, clipsContent: true }), node: "Misc", expect: { opacity: 0.5, rotation: 90, enabled: false, clip: true } },
  { name: "ROUNDED_RECTANGLE -> rectangle with figType", build: (g, p) => add(g, "ROUNDED_RECTANGLE", p, { name: "RR" }), node: "RR", expect: { type: "rectangle", figType: "ROUNDED_RECTANGLE" } },
  { name: "VECTOR -> path with figType", build: (g, p) => add(g, "VECTOR", p, { name: "V" }), node: "V", expect: { type: "path", figType: "VECTOR" } },
  { name: "BOOLEAN_OPERATION -> path with figType", build: (g, p) => add(g, "BOOLEAN_OPERATION", p, { name: "B" }), node: "B", expect: { type: "path", figType: "BOOLEAN_OPERATION" } },
  { name: "STAR -> path with figType", build: (g, p) => add(g, "STAR", p, { name: "St" }), node: "St", expect: { type: "path", figType: "STAR" } },
  { name: "POLYGON -> polygon with figType", build: (g, p) => add(g, "POLYGON", p, { name: "Po" }), node: "Po", expect: { type: "polygon", figType: "POLYGON" } },
  { name: "LINE -> line with figType", build: (g, p) => add(g, "LINE", p, { name: "L" }), node: "L", expect: { type: "line", figType: "LINE" } },
  { name: "SECTION -> frame with figType", build: (g, p) => add(g, "SECTION", p, { name: "Sec" }), node: "Sec", expect: { type: "frame", figType: "SECTION" } },
  { name: "COMPONENT_SET -> frame with figType", build: (g, p) => add(g, "COMPONENT_SET", p, { name: "Set" }), node: "Set", expect: { type: "frame", figType: "COMPONENT_SET" } },
  { name: "CONNECTOR -> line with figType", build: (g, p) => add(g, "CONNECTOR", p, { name: "Con" }), node: "Con", expect: { type: "line", figType: "CONNECTOR" } },
  { name: "SHAPE_WITH_TEXT -> frame with figType", build: (g, p) => add(g, "SHAPE_WITH_TEXT", p, { name: "Sh" }), node: "Sh", expect: { type: "frame", figType: "SHAPE_WITH_TEXT" } },
];

describe("fig normalizer mapping", () => {
  for (const row of rows) {
    it(row.name, () => {
      const node = pen(scene(row.build), row.node);
      for (const [key, value] of Object.entries(row.expect)) assert.deepEqual(node[key], value, key);
    });
  }

  it("uses the scene node id as the pen id", () => {
    const g = scene((g, p) => add(g, "FRAME", p, { name: "F" }));
    assert.equal(pen(g, "F").id, "n3");
  });

  it("makes the layers of every page, in page order, the top-level children", () => {
    const g = scene((g, p) => {
      add(g, "FRAME", p, { name: "A" });
      add(g, "FRAME", g.addPage("Second"), { name: "B" });
      add(g, "FRAME", p, { name: "C" });
    });
    assert.deepEqual(figSceneToPen(g).children.map((n) => n.name), ["A", "C", "B"]);
  });

  it("nests children and leaves instances without any", () => {
    const g = scene((g, p) => {
      const f = add(g, "FRAME", p, { name: "Outer" });
      add(g, "RECTANGLE", f, { name: "Inner" });
    });
    assert.deepEqual(pen(g, "Outer").children!.map((n) => n.name), ["Inner"]);
  });

  it("every normalized type is a known .pen type, and the document compiles without SCH-001", () => {
    const g = scene((g, p) => {
      for (const row of rows) row.build(g, p);
    });
    const doc = figSceneToPen(g);
    assert.equal(doc.version, "2.6");
    for (const node of doc.children) assert.ok(KNOWN_TYPES.includes(node.type), node.type);
    assert.deepEqual(compile(doc).diagnostics.filter((d) => d.rule === "SCH-001"), []);
  });

  it("classifies solid, gradient and image fills the way rules read them", () => {
    const g = scene((g, p) => {
      add(g, "RECTANGLE", p, { name: "S", fills: [solid(1, 1, 1)] });
      add(g, "RECTANGLE", p, { name: "G", fills: [{ type: "GRADIENT_RADIAL", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, gradientStops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 }] }] });
      add(g, "RECTANGLE", p, { name: "I", fills: [{ type: "IMAGE", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, imageHash: "h" }] });
    });
    assert.equal(solidColor(pen(g, "S").fill as never), "#ffffff");
    assert.equal(solidColor(pen(g, "G").fill as never), undefined);
    assert.deepEqual(gradientStops(pen(g, "G").fill as never), [{ color: "#000000", position: 0 }]);
    assert.equal(solidColor(pen(g, "I").fill as never), undefined);
    assert.equal(gradientStops(pen(g, "I").fill as never), undefined);
  });
});

describe("fig normalizer instances", () => {
  function withInstance(fill: (g: SceneGraph, instance: SceneNode, label: SceneNode) => void): SceneGraph {
    return scene((g, p) => {
      const c = add(g, "COMPONENT", p, { name: "Btn", width: 100, height: 30 });
      const label = add(g, "TEXT", c, { name: "Label", text: "Click" });
      const f = add(g, "FRAME", p, { name: "Screen" });
      const inst = g.createInstance(c.id, f.id, { name: "Inst", x: 7, y: 9 })!;
      fill(g, inst, label);
    });
  }

  it("is a ref to the component id with no children", () => {
    const g = withInstance(() => undefined);
    const inst = pen(g, "Inst");
    assert.equal(inst.type, "ref");
    assert.equal(inst.ref, pen(g, "Btn").id);
    assert.equal(inst.children, undefined);
    assert.deepEqual([inst.x, inst.y], [7, 9]);
    assert.equal(inst.descendants, undefined);
    assert.deepEqual(compile(figSceneToPen(g)).diagnostics, []);
  });

  it("keys descendants by the component's own node ids, not the instance's sublayers", () => {
    const g = withInstance((g, inst, label) => {
      const sub = g.getChildren(inst.id)[0]!;
      g.updateNode(sub.id, { text: "Pay" });
      inst.instanceOverrides.descendants.set(sub.id, new Map([["text", "Pay"]]));
      assert.notEqual(sub.id, label.id);
    });
    const label = pen(g, "Label");
    assert.deepEqual(pen(g, "Inst").descendants, { [label.id]: { content: "Pay" } });
    assert.equal(compile(figSceneToPen(g)).nodes.some((n) => n.props.content === "Pay"), true);
  });

  it("counts overridden sublayers that the component has no counterpart for", () => {
    const g = withInstance((g, inst) => {
      add(g, "RECTANGLE", inst, { name: "Extra" });
    });
    assert.equal(pen(g, "Inst").figUnmappedOverrides, 1);
  });

  it("keeps an instance whose component is missing as a frame with its layers", () => {
    const g = scene((g, p) => {
      const inst = add(g, "INSTANCE", p, { name: "Orphan", componentId: "nowhere" });
      add(g, "RECTANGLE", inst, { name: "Inside" });
    });
    const node = pen(g, "Orphan");
    assert.equal(node.type, "frame");
    assert.equal(node.figType, "INSTANCE");
    assert.deepEqual(node.children!.map((n) => n.name), ["Inside"]);
    assert.deepEqual(compile(figSceneToPen(g)).diagnostics, []);
  });
});

describe("fig normalizer variables", () => {
  function themed(): SceneGraph {
    return scene((g, p) => {
      const collection = g.createCollection("Brand colors");
      g.renameMode(collection.id, collection.defaultModeId, "Light mode");
      const dark = g.createMode(collection.id, "Dark")!;
      const v = g.createVariable("Primary 500", "COLOR", collection.id, { r: 1, g: 1, b: 1, a: 1 });
      v.valuesByMode[dark] = { r: 0, g: 0, b: 0, a: 0.5 };
      g.createVariable("Primary 500", "COLOR", collection.id, { r: 0, g: 0, b: 1, a: 1 });
      g.createVariable("Primary 500", "FLOAT", collection.id, 4);
      const other = g.createCollection("Size");
      g.createVariable("gap", "FLOAT", other.id, 8);
      const f = add(g, "FRAME", p, { name: "Pinned", itemSpacing: 4, layoutMode: "HORIZONTAL", variableModes: { [collection.id]: dark }, fills: [solid(1, 1, 1)] });
      g.bindVariable(f.id, "fills/0/color", v.id);
      g.bindVariable(f.id, "itemSpacing", [...g.variables.values()].find((x) => x.name === "gap")!.id);
    });
  }

  it("names a variable <collection>/<name> with whitespace as - and duplicates numbered in graph order", () => {
    assert.deepEqual(Object.keys(figSceneToPen(themed()).variables!), ["Brand-colors/Primary-500", "Brand-colors/Primary-500-2", "Brand-colors/Primary-500-3", "Size/gap"]);
  });

  it("gives one value per mode, in mode order, with the collection as the theme axis", () => {
    const doc = figSceneToPen(themed());
    assert.deepEqual(doc.variables!["Brand-colors/Primary-500"], {
      type: "color",
      value: [
        { value: "#ffffff", theme: { "Brand colors": "Light mode" } },
        { value: "#00000080", theme: { "Brand colors": "Dark" } },
      ],
    });
    assert.equal(doc.variables!["Brand-colors/Primary-500-3"]!.type, "number");
    assert.deepEqual(doc.themes, { "Brand colors": ["Light mode", "Dark"], Size: ["Mode 1"] });
  });

  it("references variables as $name in paints and numbers, and pins the explicit mode as a theme", () => {
    const node = pen(themed(), "Pinned");
    assert.equal(node.fill, "$Brand-colors/Primary-500");
    assert.equal(node.gap, "$Size/gap");
    assert.deepEqual(node.theme, { "Brand colors": "Dark" });
  });

  it("omits variables and themes when the file has none", () => {
    const doc = figSceneToPen(scene(() => undefined));
    assert.equal("variables" in doc, false);
    assert.equal("themes" in doc, false);
  });
});
