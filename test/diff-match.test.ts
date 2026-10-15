import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadPenFile, matchFrames, type PenNode } from "../src/index.js";
import { fixtureUrl } from "./helpers/fixtures.js";

const frames = async (side: "base" | "head", file: string): Promise<PenNode[]> =>
  (await loadPenFile(fileURLToPath(fixtureUrl(`${side}/${file}`)))).children;

const f = (id: string, name: string, children: PenNode[] = []): PenNode => ({ id, type: "frame", name, children });
const r = (id: string, name: string): PenNode => ({ id, type: "rectangle", name });

test("matches frames with the same id", async () => {
  const m = matchFrames(await frames("base", "fill.pen"), await frames("head", "fill.pen"));
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0]!.matchedBy, "id");
  assert.equal(m.pairs[0]!.head.id, "fill-frame");
  assert.deepEqual([m.added, m.removed], [[], []]);
});

test("matches recreated-id frames by structure", async () => {
  const m = matchFrames(await frames("base", "id-recreated.pen"), await frames("head", "id-recreated.pen"));
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0]!.matchedBy, "structure");
  assert.equal(m.pairs[0]!.base.id, "recreated-old");
  assert.equal(m.pairs[0]!.head.id, "recreated-new");
});

test("falls back to a unique name when the structure changed", async () => {
  const m = matchFrames(await frames("base", "id-recreated-changed.pen"), await frames("head", "id-recreated-changed.pen"));
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0]!.matchedBy, "name");
  assert.equal(m.pairs[0]!.head.id, "recreated-changed-new");
});

test("structure hash ignores styles and positions but not text content", () => {
  const a = f("a", "A", [{ id: "t", type: "text", name: "T", content: "x", fill: "#fff" }]);
  const b = f("b", "A", [{ id: "u", type: "text", name: "T", content: "x", fill: "#000", x: 5 }]);
  const c = f("c", "A", [{ id: "v", type: "text", name: "T", content: "y" }]);
  assert.equal(matchFrames([a], [b]).pairs[0]?.matchedBy, "structure");
  assert.equal(matchFrames([a], [c]).pairs[0]?.matchedBy, "name");
});

test("name fallback requires the name to be unique on both sides", () => {
  const base = [f("b1", "Dup", [r("x", "X")]), f("b2", "Dup", [r("y", "Y")])];
  const head = [f("h1", "Dup", [r("z", "Z")])];
  const m = matchFrames(base, head);
  assert.equal(m.pairs.length, 0);
  assert.equal(m.removed.length, 2);
  assert.equal(m.added.length, 1);

  const m2 = matchFrames([f("b1", "Dup", [r("x", "X")])], [f("h1", "Dup", [r("z", "Z")]), f("h2", "Dup", [r("w", "W")])]);
  assert.equal(m2.pairs.length, 0);
});

test("leftover frames are added or removed", async () => {
  const m = matchFrames(await frames("base", "removed.pen"), await frames("head", "added.pen"));
  assert.equal(m.pairs.length, 0);
  assert.deepEqual(m.removed.map((n) => n.id), ["file-removed-frame"]);
  assert.deepEqual(m.added.map((n) => n.id), ["file-added-frame"]);
});
