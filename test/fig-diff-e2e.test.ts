import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultDeps, runDiff } from "../src/cli/run-diff.js";
import type { ChangeBox, FrameDiff } from "../src/diff/model.js";
import type { PenFill, PenNode } from "../src/pen/types.js";
import { gradientStops, solidColor } from "../src/pen/paint.js";
import { createOpenPencilRenderer } from "../src/render/openpencil.js";
import { loadDesignSource } from "../src/source/load.js";
import { readFileSync } from "node:fs";
import { createFixtureRepo } from "./helpers/fixture-repo.js";
import { figFixturePath } from "./helpers/fig-fixtures.js";

interface Run {
  frames: FrameDiff[];
  html: string;
  json: { files: { path: string; format?: string }[] };
}

async function diffFixture(name: string): Promise<Run> {
  const fx = await createFixtureRepo({ single: { base: `fig/${name}/base.fig`, head: `fig/${name}/head.fig`, as: "design.fig" } });
  const out = await mkdtemp(path.join(tmpdir(), "fig-out-"));
  try {
    const code = await runDiff({ repo: fx.path, base: "base", head: "head", out }, { ...defaultDeps(), stdout: () => undefined, stderr: () => undefined });
    assert.equal(code, 0);
    const json = JSON.parse(await readFile(path.join(out, "diff.json"), "utf8"));
    return { frames: json.files[0].frames, html: await readFile(path.join(out, "report.html"), "utf8"), json };
  } finally {
    await fx.cleanup();
    await rm(out, { recursive: true, force: true });
  }
}

const box = (b: ChangeBox) => ({ x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind, nodeId: b.nodeId });
const frameOf = (run: Run, name: string): FrameDiff => {
  const frame = run.frames.find((f) => f.name === name);
  assert.ok(frame, name);
  return frame;
};

describe("design-gates diff on .fig fixture pairs", () => {
  it("solid fill change: modified fill and its box", async () => {
    const frame = frameOf(await diffFixture("solid-fill"), "Card");
    assert.deepEqual(frame.nodes.map((n) => ({ id: n.id, change: n.change, props: n.props })), [
      { id: "1:102", change: "modified", props: [{ path: "fill", old: "#ff0000", new: "#0000ff" }] },
    ]);
    assert.deepEqual(frame.changeBoxes.map(box), [{ x: 10, y: 10, w: 60, h: 40, kind: "modified", nodeId: "1:102" }]);
    assert.ok(frame.pixelDiffRatio!.default! > 0);
  });

  it("moved node: x and y change, head box plus pixel box of the old spot", async () => {
    const frame = frameOf(await diffFixture("moved-node"), "Canvas");
    assert.deepEqual(frame.nodes.map((n) => ({ id: n.id, change: n.change, props: n.props })), [
      { id: "1:102", change: "modified", props: [{ path: "x", old: 10, new: 90 }, { path: "y", old: 10, new: 50 }] },
    ]);
    assert.deepEqual(frame.changeBoxes.map(box), [
      { x: 10, y: 10, w: 40, h: 40, kind: "pixel", nodeId: undefined },
      { x: 90, y: 50, w: 40, h: 40, kind: "modified", nodeId: "1:102" },
    ]);
  });

  it("text change: content modified", async () => {
    const frame = frameOf(await diffFixture("text-change"), "Title card");
    assert.deepEqual(frame.nodes.map((n) => ({ id: n.id, type: n.type, props: n.props })), [
      { id: "1:102", type: "text", props: [{ path: "content", old: "Hello", new: "Hello world" }] },
    ]);
    assert.deepEqual(frame.changeBoxes.map(box), [{ x: 8, y: 8, w: 180, h: 24, kind: "modified", nodeId: "1:102" }]);
  });

  it("frame added and removed", async () => {
    const run = await diffFixture("frame-add-remove");
    assert.deepEqual(run.frames.map((f) => [f.name, f.status]), [["Alpha", "removed"], ["Beta", "modified"], ["Gamma", "added"]]);
    assert.ok(frameOf(run, "Alpha").images!.default!.base);
    assert.equal(frameOf(run, "Alpha").images!.default!.head, undefined);
    assert.ok(frameOf(run, "Gamma").images!.default!.head);
    assert.equal(frameOf(run, "Gamma").images!.default!.base, undefined);
    assert.deepEqual(frameOf(run, "Beta").nodes.map((n) => n.props), [[{ path: "x", old: 140, new: 0 }]]);
  });

  it("variable mode change: theme prop on the frame, whole-frame pixel change", async () => {
    const frame = frameOf(await diffFixture("variable-mode"), "Screen");
    assert.deepEqual(frame.nodes.map((n) => ({ id: n.id, props: n.props })), [
      { id: "1:105", props: [{ path: "theme.Theme", old: "Light", new: "Dark" }] },
    ]);
    assert.deepEqual(frame.changeBoxes.map(box), [
      { x: 0, y: 0, w: 120, h: 80, kind: "modified", nodeId: "1:105" },
      { x: 0, y: 0, w: 120, h: 80, kind: "pixel", nodeId: undefined },
    ]);
    assert.equal(frame.pixelDiffRatio!.default, 1);
  });

  it("variable value change: listed as a variable change in its theme", async () => {
    const run = await diffFixture("variable-value");
    const json = JSON.parse(JSON.stringify(run.frames));
    assert.equal(json[0].status, "unchanged");
    assert.match(run.html, /Theme\/bg/);
  });

  it("instance override: the ref node carries the override and its own box", async () => {
    const frame = frameOf(await diffFixture("instance-override"), "Screen");
    assert.deepEqual(frame.nodes.map((n) => ({ id: n.id, type: n.type, change: n.change, props: n.props })), [
      { id: "0:7", type: "ref", change: "modified", props: [{ path: "descendants", new: { "0:5": { content: "Pay now" } } }] },
    ]);
    assert.deepEqual(frame.changeBoxes.map(box), [{ x: 20, y: 20, w: 100, h: 32, kind: "modified", nodeId: "0:7" }]);
    assert.deepEqual(frame.missingBoxes, []);
  });

  it("image fill change: a fill prop, an unclassifiable paint and a pixel diff", async () => {
    const run = await diffFixture("image-fill");
    const frame = frameOf(run, "Photo card");
    assert.equal(frame.nodes.length, 1);
    assert.equal(frame.nodes[0]!.change, "modified");
    assert.deepEqual(frame.nodes[0]!.props!.map((p) => p.path), ["fill.imageHash"]);
    assert.ok(frame.nodes[0]!.props!.every((p) => p.path === "fill" || p.path.startsWith("fill.")));
    // the pixel region lies inside the node's own modified box, which absorbs it (pixelChangeBoxes)
    assert.deepEqual(frame.changeBoxes.map((b) => [b.kind, b.nodeId]), [["modified", "1:102"]]);
    assert.ok(frame.pixelDiffRatio!.default! > 0);
    const source = await loadDesignSource("d.fig", readFileSync(new URL(`../../${figFixturePath("image-fill", "head")}`, import.meta.url)));
    const find = (nodes: PenNode[]): PenNode | undefined => nodes.flatMap((n) => [n, ...(n.children ?? [])]).find((n) => n.id === "1:102") ?? (nodes.some((n) => n.children) ? find(nodes.flatMap((n) => n.children ?? [])) : undefined);
    const fill = find(source.doc.children)!.fill as PenFill | undefined;
    assert.equal(solidColor(fill), undefined);
    assert.equal(gradientStops(fill), undefined);
  });

  it("report headers name the format of .fig files only", async () => {
    const run = await diffFixture("solid-fill");
    assert.equal(run.json.files[0]!.format, "fig");
    assert.match(run.html, /<h2>design\.fig · Figma \.fig<\/h2>/);
  });
});

describe("theme selection when rendering a .fig", () => {
  const load = () => loadDesignSource("d.fig", readFileSync(new URL(`../../${figFixturePath("variable-mode", "base")}`, import.meta.url)));

  it("light and dark modes render differently; repeated renders are independent", async () => {
    const renderer = createOpenPencilRenderer();
    const source = await load();
    const r = (theme?: Record<string, string>) => renderer.renderSource!(source, "1:105", { scale: 1, ...(theme && { theme }) });
    const dark = await r({ Theme: "Dark" });
    const light = await r({ Theme: "Light" });
    const lightAgain = await r({ Theme: "Light" });
    assert.ok(!dark.png.equals(light.png));
    assert.ok(light.png.equals(lightAgain.png));
    assert.deepEqual(light.nodeBoxes, dark.nodeBoxes);
  });
});
