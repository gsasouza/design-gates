import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { designFormatOf } from "../src/source/format.js";
import { loadDesignSource, penSource } from "../src/source/load.js";
import { parseFailureViolation } from "../src/rules/parse-failure.js";
import { createOpenPencilRenderer } from "../src/render/openpencil.js";
import { parsePen } from "../src/pen/load.js";
import type { PenNode } from "../src/pen/types.js";
import { bareFig, storedZip, swapSiblings, zipFig, type FigRect } from "./helpers/fig.js";

const RED: FigRect = { id: "a", name: "A", fill: "#ff0000" };
const GREEN: FigRect = { id: "b", name: "B", fill: "#00ff00" };

/** First node called `name` (pages carry the name of their frame, so `type` tells them apart). */
const byName = (nodes: PenNode[], name: string, type?: string): PenNode | undefined => {
  for (const n of nodes) {
    if (n.name === name && (type === undefined || n.type === type)) return n;
    const found = byName(n.children ?? [], name, type);
    if (found) return found;
  }
  return undefined;
};

const penText = JSON.stringify({
  version: "2.6",
  children: [{ id: "f", type: "frame", name: "F", width: 10, height: 10, fill: "#ff0000" }],
});

describe("design source loader", () => {
  it("picks the format by extension", async () => {
    assert.equal(designFormatOf("a/b.pen"), "pen");
    assert.equal(designFormatOf("a/b.fig"), "fig");
    assert.equal(designFormatOf("a/b.txt"), undefined);
    assert.equal((await loadDesignSource("x.pen", Buffer.from(penText))).format, "pen");
    assert.equal((await loadDesignSource("x.fig", await bareFig([RED, GREEN]))).format, "fig");
    await assert.rejects(loadDesignSource("x.txt", Buffer.from("{}")), /Unsupported design file/);
  });

  it("loads .pen through parsePen on the utf8 text", async () => {
    const source = await loadDesignSource("x.pen", Buffer.from(penText));
    assert.deepEqual(source.doc, parsePen(penText));
    assert.deepEqual((await loadDesignSource("x.pen", penText)).doc, source.doc);
    await assert.rejects(loadDesignSource("x.pen", Buffer.from("[]")), /Invalid \.pen document/);
  });

  it("loads both the bare fig-kiwi blob and the zip archive", async () => {
    const canvas = await bareFig([RED, GREEN]);
    const bare = await loadDesignSource("bare.fig", canvas);
    const zipped = await loadDesignSource("zip.fig", zipFig(canvas));
    for (const source of [bare, zipped]) {
      assert.equal(source.format, "fig");
      assert.ok(byName(source.doc.children, "A"));
      assert.ok(byName(source.doc.children, "B"));
    }
    assert.deepEqual(zipped.doc, bare.doc);
  });

  it("gives the same id to the same Figma node when siblings are reordered between two files", async () => {
    const canvas = await bareFig([RED, GREEN]);
    const base = await loadDesignSource("f.fig", canvas);
    const head = await loadDesignSource("f.fig", swapSiblings(canvas, ["A", "B"]));
    const frameOf = (s: typeof base) => byName(s.doc.children, "Card", "frame")!;
    assert.deepEqual(frameOf(base).children?.map((c) => c.name), ["A", "B"]);
    assert.deepEqual(frameOf(head).children?.map((c) => c.name), ["B", "A"]);
    for (const name of ["A", "B", "Card"]) {
      assert.equal(byName(head.doc.children, name, name === "Card" ? "frame" : undefined)!.id, byName(base.doc.children, name, name === "Card" ? "frame" : undefined)!.id, name);
    }
    const idA = byName(base.doc.children, "A")!.id;
    const graph = await head.sceneFor(idA);
    assert.equal(graph.getNode(head.graphIdOf(idA)!)?.name, "A");
  });

  it("reports an unreadable .fig as an Invalid .fig document error that SCH-001 accepts", async () => {
    const error = await loadDesignSource("bad.fig", Buffer.from("not a figma file")).catch((e: unknown) => e);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid \.fig document: /);
    const violation = parseFailureViolation("bad.fig", error);
    assert.equal(violation.rule, "SCH-001");
    assert.equal(violation.file, "bad.fig");
    assert.equal(violation.message, error.message);
  });

  it("caps the input size and the declared inflated size with the cap named in the error", async () => {
    const fig = await bareFig([RED, GREEN]);
    await assert.rejects(loadDesignSource("big.fig", fig, { maxFigBytes: 100 }), /Invalid \.fig document: .*MAX_FIG_BYTES/);
    const bomb = storedZip([
      { name: "canvas.fig", data: fig, declaredSize: 600 },
      { name: "images/x.png", data: Buffer.from("png"), declaredSize: 600 },
    ]);
    await assert.rejects(loadDesignSource("bomb.fig", bomb, { maxFigInflatedBytes: 1000 }), /Invalid \.fig document: .*MAX_FIG_INFLATED_BYTES/);
    assert.equal((await loadDesignSource("ok.fig", bomb, { maxFigInflatedBytes: 1200 })).format, "fig");
    await assert.rejects(loadDesignSource("many.fig", fig, { maxNodes: 2 }), /Invalid \.fig document: .*MAX_COMPILED_NODES/);
  });

  it("fails on Git LFS pointers for both formats, naming the file", async () => {
    const pointer = Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n");
    await assert.rejects(loadDesignSource("a/x.fig", pointer), /Invalid \.fig document: a\/x\.fig is a Git LFS pointer; run git lfs pull to fetch the real \.fig/);
    await assert.rejects(loadDesignSource("a/x.pen", pointer), /Invalid \.pen document: a\/x\.pen is a Git LFS pointer; run git lfs pull to fetch the real \.pen/);
  });
});

describe("rendering from a source", () => {
  it("renderFrame(doc) and renderSource(penSource) produce the same render", async () => {
    const doc = parsePen(penText);
    const renderer = createOpenPencilRenderer();
    const a = await renderer.renderFrame(doc, "f", { scale: 1 });
    const b = await renderer.renderSource!(penSource(doc), "f", { scale: 1 });
    assert.ok(a.png.equals(b.png));
    assert.deepEqual(a.nodeBoxes, b.nodeBoxes);
  });

  it("renders a .fig frame with node boxes keyed by the doc ids", async () => {
    const source = await loadDesignSource("f.fig", await bareFig([RED, GREEN]));
    const frame = byName(source.doc.children, "Card", "frame")!;
    const out = await createOpenPencilRenderer().renderSource!(source, frame.id, { scale: 1 });
    assert.equal(out.width, 40);
    assert.equal(out.height, 20);
    const a = byName(source.doc.children, "A")!;
    assert.deepEqual(out.nodeBoxes[a.id], { x: 0, y: 0, w: 20, h: 20 });
    assert.deepEqual(out.nodeBoxes[frame.id], { x: 0, y: 0, w: 40, h: 20 });
  });

  it("a render with a theme does not leak into the next render of the same source", async () => {
    const renderer = createOpenPencilRenderer();
    for (const make of [async () => loadDesignSource("f.fig", await bareFig([RED, GREEN])), async () => penSource(parsePen(penText))]) {
      const used = await make();
      const fresh = await make();
      const id = used.format === "fig" ? byName(used.doc.children, "Card", "frame")!.id : "f";
      await renderer.renderSource!(used, id, { scale: 1, theme: { mode: "dark" } });
      const again = await renderer.renderSource!(used, id, { scale: 1 });
      const expected = await renderer.renderSource!(fresh, id, { scale: 1 });
      assert.ok(again.png.equals(expected.png), used.format);
      assert.deepEqual(again.nodeBoxes, expected.nodeBoxes, used.format);
    }
  });
});
