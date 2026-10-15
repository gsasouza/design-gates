import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenPencilRenderer, loadPenFile } from "../src/index.js";
import { fixtureUrl } from "./helpers/fixtures.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const simple = await loadPenFile(fixtureUrl("spike/simple.pen").pathname);
const themed = await loadPenFile(fixtureUrl("spike/themed.pen").pathname);

test("renders simple.pen to a valid PNG sized like the frame", async () => {
  const out = await createOpenPencilRenderer().renderFrame(simple, "frame", { scale: 1 });
  assert.deepEqual(out.png.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(out.png.readUInt32BE(16), out.width);
  assert.equal(out.png.readUInt32BE(20), out.height);
  assert.equal(out.width, 200);
  assert.equal(out.height, 100);
});

test("scale multiplies the output size and the node boxes", async () => {
  const out = await createOpenPencilRenderer().renderFrame(simple, "frame", { scale: 2 });
  assert.equal(out.width, 400);
  assert.equal(out.height, 200);
  assert.deepEqual(out.nodeBoxes.rect, { x: 20, y: 20, w: 160, h: 80 });
});

test("two renders are byte-identical", async () => {
  const renderer = createOpenPencilRenderer();
  const a = await renderer.renderFrame(simple, "frame", { scale: 1 });
  const b = await renderer.renderFrame(simple, "frame", { scale: 1 });
  assert.ok(a.png.equals(b.png));
});

test("nodeBoxes contain the rectangle and the text in frame coordinates", async () => {
  const { nodeBoxes } = await createOpenPencilRenderer().renderFrame(simple, "frame", { scale: 1 });
  assert.deepEqual(nodeBoxes.frame, { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(nodeBoxes.rect, { x: 10, y: 10, w: 80, h: 40 });
  const label = nodeBoxes.label;
  assert.ok(label);
  assert.equal(label.x, 20);
  assert.equal(label.y, 60);
  assert.ok(label.w > 0 && label.h > 0);
});

test("theme renders different pixels without mutating the document", async () => {
  const renderer = createOpenPencilRenderer();
  const before = JSON.stringify(themed);
  const light = await renderer.renderFrame(themed, "frame", { scale: 1 });
  const dark = await renderer.renderFrame(themed, "frame", { scale: 1, theme: { mode: "dark" } });
  assert.ok(!light.png.equals(dark.png));
  assert.equal(JSON.stringify(themed), before);
});

test("a component instanced under the frame theme and a nested dark pin renders both instances distinctly", async () => {
  const doc = {
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables: {
      c: {
        type: "color",
        value: [
          { value: "#ffffff", theme: { mode: "light" } },
          { value: "#000000", theme: { mode: "dark" } },
        ],
      },
    },
    children: [
      {
        id: "card",
        type: "frame",
        reusable: true,
        layout: "none",
        width: 20,
        height: 20,
        fill: "$c",
        children: [{ id: "dot", type: "rectangle", x: 5, y: 5, width: 10, height: 10, fill: "#ff0000" }],
      },
      {
        id: "frame",
        type: "frame",
        layout: "none",
        width: 60,
        height: 20,
        children: [
          { id: "light-inst", type: "ref", ref: "card", x: 0, y: 0 },
          {
            id: "dark-pin",
            type: "frame",
            layout: "none",
            theme: { mode: "dark" },
            x: 30,
            y: 0,
            width: 30,
            height: 20,
            children: [{ id: "dark-inst", type: "ref", ref: "card", x: 0, y: 0, descendants: { dot: { fill: "#00ff00" } } }],
          },
        ],
      },
    ],
  } as unknown as Parameters<ReturnType<typeof createOpenPencilRenderer>["renderFrame"]>[0];
  const out = await createOpenPencilRenderer().renderFrame(doc, "frame", { scale: 1 });
  const a = out.nodeBoxes["light-inst"];
  const b = out.nodeBoxes["dark-inst"];
  assert.ok(a && b);
  assert.notDeepEqual(a, b);
  const { PNG } = await import("pngjs");
  const img = PNG.sync.read(out.png);
  const px = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(px(1, 1), [255, 255, 255]);
  assert.deepEqual(px(31, 1), [0, 0, 0]);
  assert.deepEqual(px(10, 10), [255, 0, 0]);
  assert.deepEqual(px(40, 10), [0, 255, 0]);
});
