import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PNG } from "pngjs";
import {
  computeVisualDiff,
  fileSlug,
  nodeChangeBoxes,
  pixelChangeBoxes,
  pixelDiff,
  sortBoxes,
  type ChangeBox,
  type DiffDocs,
  type DiffResult,
  type FrameDiff,
  type NodeChange,
  type PenDocument,
} from "../src/index.js";
import { imagePaths } from "../src/visual/render-frames.js";
import { BLACK, WHITE, fakeRenderer, fillRect, makePng, render, type Rgba } from "./helpers/png.js";

const doc = (label: string): PenDocument => ({ version: "2.6", children: [], label }) as unknown as PenDocument;

function frame(over: Partial<FrameDiff> & { id: string }): FrameDiff {
  return {
    name: over.id,
    status: "modified",
    matchedBy: "id",
    counts: { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 },
    nodes: [],
    changeBoxes: [],
    missingBoxes: [],
    pixelDiffRatio: null,
    images: null,
    ...over,
  };
}

function resultOf(file: string, frames: FrameDiff[], extra: Partial<DiffResult> = {}): DiffResult {
  return {
    schemaVersion: 1,
    base: { ref: "base", sha: "a" },
    head: { ref: "head", sha: "b" },
    files: [{ path: file, status: "modified", frames }],
    variables: [],
    themes: [],
    ...extra,
  };
}

function memoryFs() {
  const files = new Map<string, Buffer>();
  return {
    files,
    fs: {
      mkdir: async () => undefined,
      writeFile: async (file: string, data: Buffer) => {
        files.set(file, data);
      },
    },
  };
}

const change = (id: string, kind: NodeChange["change"]): NodeChange => ({ id, name: `n-${id}`, type: "rectangle", change: kind });

test("pixelDiffRatio is changed pixels over total pixels for a known block", () => {
  const base = makePng(10, 10, WHITE);
  const head = makePng(10, 10, WHITE, (set) => fillRect(set, 2, 2, 2, 5, BLACK));
  const d = pixelDiff(base, head);
  assert.equal(d.ratio, 0.1);
  assert.equal(d.mask.reduce((a, b) => a + b, 0), 10);
});

test("pixelDiffRatio is rounded to 6 decimals", () => {
  const base = makePng(30, 11, WHITE);
  const head = makePng(30, 11, WHITE, (set) => set(0, 0, BLACK));
  assert.equal(pixelDiff(base, head).ratio, 0.003030);
});

test("a one-pixel anti-aliased edge does not count, a real change in the same place does", () => {
  const edge = (gray: number) =>
    makePng(10, 10, WHITE, (set) => {
      fillRect(set, 0, 0, 5, 10, BLACK);
      fillRect(set, 5, 0, 1, 10, [gray, gray, gray, 255]);
    });
  assert.equal(pixelDiff(edge(255), edge(128)).ratio, 0);
  const solid = makePng(10, 10, WHITE);
  const block = makePng(10, 10, WHITE, (set) => fillRect(set, 4, 4, 3, 3, BLACK));
  assert.ok(pixelDiff(solid, block).ratio > 0);
});

test("the threshold is respected", () => {
  const gray = (v: number) => makePng(8, 8, [v, v, v, 255]);
  assert.equal(pixelDiff(gray(100), gray(110)).ratio, 0);
  assert.equal(pixelDiff(gray(100), gray(110), { threshold: 0.001 }).ratio, 1);
});

test("the diff image dims the base and highlights changed pixels", () => {
  const base = makePng(6, 6, BLACK);
  const head = makePng(6, 6, BLACK, (set) => set(3, 3, WHITE));
  const out = PNG.sync.read(pixelDiff(base, head).diffPng);
  const at = (x: number, y: number) => [...out.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 3)];
  assert.deepEqual(at(3, 3), [255, 0, 0]);
  assert.ok(at(0, 0).every((c) => c > 200), "unchanged base pixels are dimmed towards white");
});

test("different sizes are padded top-left onto a common transparent canvas", () => {
  const base = makePng(10, 10, WHITE);
  const head = makePng(14, 12, WHITE);
  const d = pixelDiff(base, head);
  assert.equal(d.width, 14);
  assert.equal(d.height, 12);
  assert.equal(d.mask.length, 14 * 12);
  // The overlapping 10x10 top-left area is identical; only the padded L-shape differs.
  assert.equal(d.mask[0], 0);
  assert.equal(d.mask[11 * 14 + 13], 1);
  assert.equal(d.ratio, Math.round(((14 * 12 - 100) / (14 * 12)) * 1e6) / 1e6);
  const out = PNG.sync.read(d.diffPng);
  assert.equal(out.width, 14);
  assert.equal(out.height, 12);
});

test("pixel regions: 8-connected components, tiny ones dropped, overlapping ones merged", () => {
  const w = 40;
  const h = 20;
  const mask = new Uint8Array(w * h);
  const set = (x: number, y: number) => {
    mask[y * w + x] = 1;
  };
  // Diagonally touching 2x2 blocks form one component.
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3], [4, 3], [3, 4], [4, 4]] as const) set(x, y);
  // A separate 3x3 block.
  for (let y = 10; y < 13; y++) for (let x = 20; x < 23; x++) set(x, y);
  // A single pixel (below min area).
  set(35, 2);
  // A ring with a dot inside: two components whose bounding boxes overlap.
  for (let i = 0; i < 7; i++) {
    set(10 + i, 5);
    set(10 + i, 11 - 0);
  }
  for (let j = 5; j <= 11; j++) {
    set(10, j);
    set(16, j);
  }
  for (const [x, y] of [[12, 7], [13, 7], [12, 8], [13, 8]] as const) set(x, y);

  const boxes = pixelChangeBoxes(mask, w, h, [], { minArea: 4 });
  assert.deepEqual(
    boxes.map(({ x, y, w: bw, h: bh }) => [x, y, bw, bh]),
    [
      [1, 1, 4, 4],
      [10, 5, 7, 7],
      [20, 10, 3, 3],
    ],
  );
  assert.ok(boxes.every((b) => b.kind === "pixel"));
  assert.equal(pixelChangeBoxes(mask, w, h, [], { minArea: 1 }).length, 4);
});

test("a pixel region mostly covered by a node box is dropped", () => {
  const mask = new Uint8Array(100);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * 10 + x] = 1;
  const node: ChangeBox = { x: 0, y: 0, w: 6, h: 6, kind: "modified", side: "head", nodeId: "a" };
  assert.equal(pixelChangeBoxes(mask, 10, 10, [node]).length, 0);
  const far: ChangeBox = { x: 8, y: 8, w: 2, h: 2, kind: "modified", side: "head", nodeId: "b" };
  assert.equal(pixelChangeBoxes(mask, 10, 10, [far]).length, 1);
});

// Frame-root and whole-image node boxes used to swallow every pixel region inside them; they no
// longer count, so those regions stay as pixel markers (only the box list gains entries).
test("a pixel region inside the frame-root box or a whole-image box is kept", () => {
  const mask = new Uint8Array(100);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * 10 + x] = 1;
  const root: ChangeBox = { x: 0, y: 0, w: 8, h: 8, kind: "modified", side: "head", nodeId: "frame" };
  assert.equal(pixelChangeBoxes(mask, 10, 10, [root]).length, 0);
  assert.equal(pixelChangeBoxes(mask, 10, 10, [root], { rootIds: ["frame"] }).length, 1);
  const whole: ChangeBox = { x: 0, y: 0, w: 10, h: 10, kind: "modified", side: "head", nodeId: "other" };
  assert.equal(pixelChangeBoxes(mask, 10, 10, [whole]).length, 1);
});

test("a pixel region under half covered by a node box is kept", () => {
  const mask = new Uint8Array(100);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * 10 + x] = 1;
  const part: ChangeBox = { x: 0, y: 0, w: 3, h: 6, kind: "modified", side: "head", nodeId: "a" };
  assert.equal(pixelChangeBoxes(mask, 10, 10, [part]).length, 1);
});

test("node boxes: removed and moved-from use base, added/modified/moved-to/reordered use head", () => {
  const baseBoxes = { r: { x: 1, y: 1, w: 5, h: 5 }, mv: { x: 0, y: 0, w: 2, h: 2 }, a: { x: 99, y: 99, w: 1, h: 1 } };
  const headBoxes = { a: { x: 10, y: 10, w: 4, h: 4 }, m: { x: 20, y: 20, w: 3, h: 3 }, mv: { x: 30, y: 30, w: 2, h: 2 }, o: { x: 40, y: 40, w: 1.2, h: 1.2 }, r: { x: 77, y: 77, w: 1, h: 1 } };
  const { boxes, missing } = nodeChangeBoxes(
    [change("r", "removed"), change("a", "added"), change("m", "modified"), change("mv", "moved"), change("o", "reordered")],
    baseBoxes,
    headBoxes,
  );
  const by = (id: string, side: string) => boxes.find((b) => b.nodeId === id && b.side === side);
  assert.deepEqual(by("r", "base"), { x: 1, y: 1, w: 5, h: 5, kind: "removed", side: "base", nodeId: "r", name: "n-r" });
  assert.equal(by("r", "head"), undefined);
  assert.deepEqual(by("a", "head"), { x: 10, y: 10, w: 4, h: 4, kind: "added", side: "head", nodeId: "a", name: "n-a" });
  assert.equal(by("a", "base"), undefined);
  assert.equal(by("m", "head")?.kind, "modified");
  assert.equal(by("mv", "base")?.x, 0);
  assert.equal(by("mv", "head")?.x, 30);
  assert.deepEqual(by("o", "head"), { x: 40, y: 40, w: 2, h: 2, kind: "reordered", side: "head", nodeId: "o", name: "n-o" });
  assert.deepEqual(missing, []);
});

test("boxes are sorted by y, x, w, h, kind, nodeId", () => {
  const b = (o: Partial<ChangeBox>): ChangeBox => ({ x: 0, y: 0, w: 1, h: 1, kind: "modified", side: "head", ...o });
  const sorted = sortBoxes([
    b({ y: 5 }),
    b({ x: 3 }),
    b({ nodeId: "z" }),
    b({ nodeId: "a" }),
    b({ kind: "added", nodeId: "q" }),
    b({ h: 2 }),
    b({ w: 2 }),
    b({ x: 1, y: 0 }),
    b({}),
  ]);
  assert.deepEqual(
    sorted.map((x) => [x.y, x.x, x.w, x.h, x.kind, x.nodeId ?? ""]),
    [
      [0, 0, 1, 1, "added", "q"],
      [0, 0, 1, 1, "modified", ""],
      [0, 0, 1, 1, "modified", "a"],
      [0, 0, 1, 1, "modified", "z"],
      [0, 0, 1, 2, "modified", ""],
      [0, 0, 2, 1, "modified", ""],
      [0, 1, 1, 1, "modified", ""],
      [0, 3, 1, 1, "modified", ""],
      [5, 0, 1, 1, "modified", ""],
    ],
  );
});

test("computeVisualDiff fills boxes, ratio and images and writes files under outDir/images/<slug>", async () => {
  const baseDoc = doc("base");
  const headDoc = doc("head");
  const basePng = makePng(20, 20, WHITE);
  const headPng = makePng(20, 20, WHITE, (set) => fillRect(set, 5, 5, 4, 4, BLACK));
  const renderer = fakeRenderer((d) =>
    d === baseDoc ? render(basePng, { n1: { x: 0, y: 0, w: 20, h: 20 } }) : render(headPng, { n1: { x: 5, y: 5, w: 4, h: 4 } }),
  );
  const f = frame({ id: "f1", baseId: "f1", headId: "f1", nodes: [change("n1", "modified")] });
  const result = resultOf("designs/a b.pen", [f]);
  const mem = memoryFs();
  const docs: DiffDocs = { "designs/a b.pen": { base: baseDoc, head: headDoc } };
  const out = await computeVisualDiff({ result, docs, renderer, outDir: "/out", scale: 2, fs: mem.fs });

  const slug = fileSlug("designs/a b.pen");
  assert.match(slug, /^designs-a-b\.pen-[0-9a-f]{8}$/);
  assert.notEqual(fileSlug("a/b"), fileSlug("a-b"));
  const got = out.files[0]!.frames[0]!;
  const stem = /^images\/.+\/f1-[0-9a-f]{8}-(base|head|diff)\.png$/;
  const paths = got.images!.default!;
  for (const kind of ["base", "head", "diff"] as const) {
    assert.match(paths[kind]!, stem);
    assert.ok(paths[kind]!.startsWith(`images/${slug}/`));
    assert.ok(paths[kind]!.endsWith(`-${kind}.png`));
  }
  assert.deepEqual([...mem.files.keys()].sort(), Object.values(got.images!.default!).map((p) => path.join("/out", p)).sort());
  assert.equal(got.pixelDiffRatio?.default, 0.04);
  assert.deepEqual(got.changeBoxes, [{ x: 5, y: 5, w: 4, h: 4, kind: "modified", side: "head", nodeId: "n1", name: "n-n1" }]);
  assert.deepEqual(renderer.calls.map((c) => c.scale), [2, 2]);
});

test("frame ids that sanitize alike get distinct image paths", async () => {
  const png = makePng(8, 8, BLACK);
  const renders = [{ key: "default", diff: pixelDiff(png, png), base: { png, boxes: {} }, head: { png, boxes: {} } }];
  const a = imagePaths("f.pen", "a/b", renders).images.default!.base;
  const b = imagePaths("f.pen", "a-b", renders).images.default!.base;
  assert.notEqual(a, b);
});

test("added and removed frames get only the side that exists", async () => {
  const baseDoc = doc("base");
  const headDoc = doc("head");
  const png = makePng(8, 8, BLACK);
  const renderer = fakeRenderer(() => render(png, { x: { x: 0, y: 0, w: 8, h: 8 } }));
  const result = resultOf("f.pen", [
    frame({ id: "add", headId: "add", status: "added", matchedBy: null }),
    frame({ id: "rem", baseId: "rem", status: "removed", matchedBy: null }),
  ]);
  const mem = memoryFs();
  await computeVisualDiff({ result, docs: { "f.pen": { base: baseDoc, head: headDoc } }, renderer, outDir: "/o", fs: mem.fs });
  const [add, rem] = result.files[0]!.frames;
  assert.deepEqual(Object.keys(add!.images!.default!).sort(), ["diff", "head"]);
  assert.deepEqual(Object.keys(rem!.images!.default!).sort(), ["base", "diff"]);
  assert.equal(add!.pixelDiffRatio?.default, 1);
  assert.deepEqual(renderer.calls.map((c) => c.frameId), ["add", "rem"]);
});

test("a node the renderer gives no box for is listed in missingBoxes, never invented", async () => {
  const headPng = makePng(20, 20, WHITE, (set) => fillRect(set, 2, 2, 6, 6, BLACK));
  const renderer = fakeRenderer((d) =>
    (d as unknown as { label: string }).label === "base" ? render(makePng(20, 20, WHITE)) : render(headPng, { has: { x: 12, y: 12, w: 3, h: 3 } }),
  );
  const f = frame({ id: "f", baseId: "f", headId: "f", nodes: [change("has", "modified"), change("lost", "modified")] });
  const result = resultOf("f.pen", [f]);
  await computeVisualDiff({ result, docs: { "f.pen": { base: doc("base"), head: doc("head") } }, renderer, outDir: "/o", fs: memoryFs().fs });
  assert.deepEqual(f.missingBoxes, ["lost"]);
  assert.deepEqual(f.changeBoxes.map((b) => [b.kind, b.nodeId]), [["pixel", undefined], ["modified", "has"]]);
  assert.deepEqual(f.changeBoxes[0], { x: 2, y: 2, w: 6, h: 6, kind: "pixel", side: "head" });
});

test("unchanged frames are not rendered; variable-listed ones render per theme", async () => {
  const baseDoc = doc("base");
  const headDoc = doc("head");
  const light = makePng(10, 10, WHITE);
  const darkBase = makePng(10, 10, BLACK);
  const darkHead = makePng(10, 10, BLACK, (set) => fillRect(set, 0, 0, 5, 5, [60, 60, 60, 255] as Rgba));
  const renderer = fakeRenderer((d, _id, theme) => render(theme?.mode === "dark" ? (d === baseDoc ? darkBase : darkHead) : light));
  const quiet = frame({ id: "quiet", baseId: "quiet", headId: "quiet", status: "unchanged" });
  const themed = frame({ id: "themed", baseId: "themed", headId: "themed", status: "unchanged" });
  const result = resultOf("v.pen", [quiet, themed], {
    variables: [{ file: "v.pen", name: "bg", change: "modified", theme: "mode=dark", frames: [{ file: "v.pen", frameId: "themed" }] }],
  });
  await computeVisualDiff({ result, docs: { "v.pen": { base: baseDoc, head: headDoc } }, renderer, outDir: "/o", fs: memoryFs().fs });
  assert.equal(quiet.images, null);
  assert.equal(quiet.pixelDiffRatio, null);
  assert.ok(renderer.calls.every((c) => c.frameId === "themed"));
  assert.deepEqual(Object.keys(themed.images!), ["default", "mode=dark"]);
  assert.equal(themed.pixelDiffRatio?.default, 0);
  assert.equal(themed.pixelDiffRatio!["mode=dark"]! > 0, true);
  assert.match(themed.images!["mode=dark"]!.head!, /themed-mode-dark-[0-9a-f]{8}-head\.png$/);
  assert.deepEqual(renderer.calls.filter((c) => c.theme).map((c) => c.theme), [{ mode: "dark" }, { mode: "dark" }]);
});
