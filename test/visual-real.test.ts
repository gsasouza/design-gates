import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeSemanticDiffWithDocs,
  computeVisualDiff,
  createOpenPencilRenderer,
  serializeDiff,
  type DiffResult,
  type FrameDiff,
  type Renderer,
} from "../src/index.js";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";

let fx: FixtureRepo;
let outDirs: string[] = [];
const rendered: string[] = [];

before(async () => {
  fx = await createFixtureRepo();
});
after(async () => {
  await fx.cleanup();
  await Promise.all(outDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function visualDiff(threshold?: number): Promise<{ result: DiffResult; outDir: string }> {
  const { result, docs } = await computeSemanticDiffWithDocs({ repo: fx.path, base: "base", head: "head" });
  const real = createOpenPencilRenderer();
  const renderer: Renderer = {
    async renderFrame(doc, frameId, opts) {
      rendered.push(frameId);
      return real.renderFrame(doc, frameId, opts);
    },
  };
  const outDir = await mkdtemp(path.join(tmpdir(), "dg-visual-"));
  outDirs.push(outDir);
  await computeVisualDiff({ result, docs, renderer, outDir, scale: 1, threshold });
  return { result, outDir };
}

const frameOf = (result: DiffResult, file: string, id: string): FrameDiff =>
  result.files.find((f) => f.path === file)!.frames.find((f) => f.id === id)!;

test("the colour-change frame has a pixel ratio and a modified box over the changed node", async () => {
  const { result, outDir } = await visualDiff();
  const f = frameOf(result, "fill.pen", "fill-frame");
  assert.ok(f.pixelDiffRatio!.default! > 0);
  const box = f.changeBoxes.find((b) => b.kind === "modified" && b.nodeId === "fill-rect");
  assert.ok(box, "a modified box for fill-rect");
  assert.ok(box.w > 0 && box.h > 0);
  for (const p of Object.values(f.images!.default!)) {
    const png = await readFile(path.join(outDir, p));
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  }
});

test("every changed frame of the fixture repo has boxes and a pixel ratio", async () => {
  const { result } = await visualDiff();
  const changed = result.files.flatMap((f) => f.frames.filter((fr) => fr.status !== "unchanged"));
  assert.ok(changed.length > 0);
  for (const f of changed) {
    assert.ok(f.pixelDiffRatio && typeof f.pixelDiffRatio.default === "number", `${f.id} ratio`);
    if (f.id === "missing-frame") {
      assert.deepEqual(f.changeBoxes, [], "no invented boxes");
      assert.deepEqual(f.missingBoxes, ["ai-prompt"]);
    } else {
      assert.ok(f.changeBoxes.length > 0, `${f.id} boxes`);
    }
  }
});

test("an unchanged frame is not rendered", async () => {
  rendered.length = 0;
  const { result } = await visualDiff();
  const none = frameOf(result, "variable.pen", "var-none-frame");
  assert.equal(none.images, null);
  assert.equal(none.pixelDiffRatio, null);
  assert.ok(!rendered.includes("var-none-frame"));
  assert.ok(rendered.includes("fill-frame"));
});

test("a dark-only variable change gives a pixel ratio for the dark key", async () => {
  const { result } = await visualDiff();
  const f = frameOf(result, "variable.pen", "var-frame");
  assert.equal(f.status, "unchanged");
  assert.equal(f.pixelDiffRatio!.default, 0);
  assert.ok(f.pixelDiffRatio!["mode=dark"]! > 0);
  assert.ok(f.images!["mode=dark"]!.diff);
  assert.ok(f.changeBoxes.some((b) => b.kind === "pixel"));
});

test("running twice gives byte-identical serialized diff.json and images", async () => {
  const a = await visualDiff();
  const b = await visualDiff();
  assert.equal(serializeDiff(a.result), serializeDiff(b.result));
  const f = frameOf(a.result, "fill.pen", "fill-frame");
  const diffPath = f.images!.default!.diff!;
  assert.deepEqual(await readFile(path.join(a.outDir, diffPath)), await readFile(path.join(b.outDir, diffPath)));
});
