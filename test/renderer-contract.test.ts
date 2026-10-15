import { test } from "node:test";
import assert from "node:assert/strict";
import type { PenDocument, Renderer } from "../src/index.js";

const doc: PenDocument = { version: "2.6", children: [{ id: "f", type: "frame" }] };

const fake: Renderer = {
  async renderFrame(_doc, frameId, opts) {
    return {
      png: Buffer.from([0x89]),
      width: 10 * opts.scale,
      height: 20 * opts.scale,
      nodeBoxes: { [frameId]: { x: 0, y: 0, w: 10 * opts.scale, h: 20 * opts.scale } },
    };
  },
};

test("Renderer contract: result carries png, size and per-node boxes", async () => {
  const out = await fake.renderFrame(doc, "f", { scale: 2, theme: { mode: "dark" } });
  assert.ok(Buffer.isBuffer(out.png));
  assert.equal(out.width, 20);
  assert.equal(out.height, 40);
  assert.deepEqual(out.nodeBoxes.f, { x: 0, y: 0, w: 20, h: 40 });
});
