import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SceneGraph } from "@open-pencil/core";
import { parseFigFile } from "@open-pencil/core/io/formats/fig";
import { compile } from "../src/compile/compile.js";
import { MAX_COMPILED_NODES } from "../src/compile/constants.js";
import type { PenNode } from "../src/pen/types.js";
import { loadDesignSource } from "../src/source/load.js";
import { FIG_FIXTURES, type FigSide, figFixturePath, stableGraph, writeFig } from "./helpers/fig-fixtures.js";

const read = (name: string, side: FigSide): Buffer => readFileSync(new URL(`../../${figFixturePath(name, side)}`, import.meta.url));
const parse = (bytes: Uint8Array): Promise<SceneGraph> => parseFigFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

const flat = (nodes: PenNode[]): PenNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const load = async (name: string, side: FigSide) => loadDesignSource(`${name}/${side}.fig`, read(name, side));
const find = (nodes: PenNode[], id: string): PenNode => {
  const node = flat(nodes).find((n) => n.id === id);
  assert.ok(node, `node ${id}`);
  return node;
};

describe("committed .fig fixtures", () => {
  for (const fixture of FIG_FIXTURES) {
    for (const side of ["base", "head"] as const) {
      it(`${fixture.name}/${side}.fig is what the generator builds`, async () => {
        const regenerated = await writeFig(fixture.build(side));
        assert.equal(stableGraph(await parse(regenerated)), stableGraph(await parse(read(fixture.name, side))));
      });
    }
  }

  it("writes the same bytes every time (fixed clock, fixed ids)", async () => {
    const [first, second] = [await writeFig(FIG_FIXTURES[0]!.build("base")), await writeFig(FIG_FIXTURES[0]!.build("base"))];
    assert.deepEqual(Buffer.from(first), Buffer.from(second));
  });

  it("is stored as the zip archive Figma saves", () => {
    for (const fixture of FIG_FIXTURES) assert.equal(read(fixture.name, "base").readUInt32LE(0), 0x04034b50);
  });

  it("normalizes into documents the compiler accepts, with the fig version kept apart", async () => {
    for (const fixture of FIG_FIXTURES) {
      for (const side of ["base", "head"] as const) {
        const source = await load(fixture.name, side);
        assert.equal(source.doc.version, "2.6");
        assert.equal(typeof source.figVersion, "number");
        assert.ok(flat(source.doc.children).length < MAX_COMPILED_NODES);
        assert.deepEqual(compile(source.doc).diagnostics, [], `${fixture.name}/${side}`);
      }
    }
  });

  it("solid-fill: the box fill changes colour and keeps its id", async () => {
    const [base, head] = [await load("solid-fill", "base"), await load("solid-fill", "head")];
    assert.equal(find(base.doc.children, "1:102").fill, "#ff0000");
    assert.equal(find(head.doc.children, "1:102").fill, "#0000ff");
    assert.equal(base.doc.children[0]!.id, "1:101");
    assert.equal(base.doc.children[0]!.layout, "none");
  });

  it("moved-node: only the position changes", async () => {
    const [base, head] = [await load("moved-node", "base"), await load("moved-node", "head")];
    const [b, h] = [find(base.doc.children, "1:102"), find(head.doc.children, "1:102")];
    assert.deepEqual([b.x, b.y, h.x, h.y], [10, 10, 90, 50]);
    assert.deepEqual({ ...b, x: 0, y: 0 }, { ...h, x: 0, y: 0 });
  });

  it("text-change: the content changes", async () => {
    const [base, head] = [await load("text-change", "base"), await load("text-change", "head")];
    const [b, h] = [find(base.doc.children, "1:102"), find(head.doc.children, "1:102")];
    assert.equal(b.type, "text");
    assert.deepEqual([b.content, h.content], ["Hello", "Hello world"]);
    assert.deepEqual([b.fontFamily, b.fontSize, b.fill], ["Inter", 16, "#000000"]);
  });

  it("frame-add-remove: Alpha leaves, Gamma arrives, Beta keeps its id", async () => {
    const [base, head] = [await load("frame-add-remove", "base"), await load("frame-add-remove", "head")];
    assert.deepEqual(base.doc.children.map((n) => [n.id, n.name]), [["1:101", "Alpha"], ["1:102", "Beta"]]);
    assert.deepEqual(head.doc.children.map((n) => [n.id, n.name]), [["1:102", "Beta"], ["1:103", "Gamma"]]);
  });

  it("variable-mode: the frame pins Dark in head and the collection is the theme axis", async () => {
    const [base, head] = [await load("variable-mode", "base"), await load("variable-mode", "head")];
    assert.deepEqual(base.doc.themes, { Theme: ["Light", "Dark"] });
    assert.deepEqual(base.doc.children[0]!.theme, { Theme: "Light" });
    assert.deepEqual(head.doc.children[0]!.theme, { Theme: "Dark" });
    assert.equal(head.doc.children[0]!.fill, "$Theme/bg");
    assert.deepEqual(head.doc.variables, base.doc.variables);
    assert.deepEqual(base.doc.variables!["Theme/bg"]!.value, [
      { value: "#ffffff", theme: { Theme: "Light" } },
      { value: "#121212", theme: { Theme: "Dark" } },
    ]);
  });

  it("variable-value: the Light value of the variable changes", async () => {
    const [base, head] = [await load("variable-value", "base"), await load("variable-value", "head")];
    const light = (s: typeof base): unknown => (s.doc.variables!["Theme/bg"]!.value as { value: unknown }[])[0]!.value;
    assert.deepEqual([light(base), light(head)], ["#ffffff", "#fafafa"]);
  });

  it("instance-override: a ref to the component with the label override keyed by the component's own node", async () => {
    const [base, head] = [await load("instance-override", "base"), await load("instance-override", "head")];
    const component = base.doc.children.find((n) => n.name === "Button")!;
    assert.equal(component.reusable, true);
    const [b, h] = [find(base.doc.children, "1:1000"), find(head.doc.children, "1:1000")];
    assert.equal(h.type, "ref");
    assert.equal(h.ref, component.id);
    assert.equal(h.children, undefined);
    assert.equal(b.descendants, undefined);
    assert.deepEqual(h.descendants, { [component.children![0]!.id]: { content: "Pay now" } });
    const label = compile(head.doc).nodes.find((n) => n.props.content === "Pay now");
    assert.ok(label, "the override reaches the compiled label");
  });

  it("image-fill: the image hash is in the fill, so another image is another fill", async () => {
    const [base, head] = [await load("image-fill", "base"), await load("image-fill", "head")];
    const [b, h] = [find(base.doc.children, "1:102").fill, find(head.doc.children, "1:102").fill] as { type: string; imageHash: string }[];
    assert.equal(b.type, "image");
    assert.match(b.imageHash, /^[0-9a-f]{40}$/);
    assert.notEqual(b.imageHash, h.imageHash);
  });
});
