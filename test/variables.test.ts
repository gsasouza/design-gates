import { test } from "node:test";
import assert from "node:assert/strict";
import type { PenDocument, PenNode } from "../src/pen/types.js";
import { prepareDocument } from "../src/render/openpencil.js";

function docWith(variables: Record<string, unknown>): PenDocument {
  return {
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables,
    children: [{ id: "frame", type: "frame", width: 10, height: 10, fill: "$c" }],
  } as unknown as PenDocument;
}

const fillOf = (doc: PenDocument): unknown => (doc.children[0] as PenNode & { fill?: unknown }).fill;

test("the last satisfied entry wins, even when it has no theme", () => {
  const doc = docWith({ c: { type: "color", value: [{ value: "#aaaaaa", theme: { mode: "dark" } }, { value: "#bbbbbb" }] } });
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "dark" })), "#bbbbbb");
});

test("a later themed entry still beats an earlier unthemed one", () => {
  const doc = docWith({ c: { type: "color", value: [{ value: "#bbbbbb" }, { value: "#aaaaaa", theme: { mode: "dark" } }] } });
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "dark" })), "#aaaaaa");
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "light" })), "#bbbbbb");
});

test("alias chains resolve through several levels", () => {
  const doc = docWith({
    c: { type: "color", value: "$b" },
    b: { type: "color", value: [{ value: "$a" }] },
    a: { type: "color", value: [{ value: "#111111" }, { value: "#222222", theme: { mode: "dark" } }] },
  });
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "dark" })), "#222222");
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "light" })), "#111111");
});

test("an alias cycle throws a clear error", () => {
  const doc = docWith({ c: { type: "color", value: "$d" }, d: { type: "color", value: "$c" } });
  assert.throws(() => prepareDocument(doc, "frame"), /alias cycle: \$c -> \$d -> \$c/);
});

test("a $name string inside an array is resolved like any other reference", () => {
  const doc = docWith({ c: { type: "color", value: "#123456" } });
  (doc.children[0] as unknown as { stops: unknown }).stops = ["$c", "plain", { color: "$c" }];
  const baked = prepareDocument(doc, "frame").children[0] as unknown as { stops: unknown };
  assert.deepEqual(baked.stops, ["#123456", "plain", { color: "#123456" }]);
});

test("a component outside the frame is baked with the rendered frame's theme", () => {
  const doc = {
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables: { c: { type: "color", value: [{ value: "#ffffff", theme: { mode: "light" } }, { value: "#000000", theme: { mode: "dark" } }] } },
    children: [
      { id: "comp", type: "frame", width: 5, height: 5, reusable: true, fill: "$c" },
      { id: "frame", type: "frame", width: 10, height: 10, children: [{ id: "i", type: "ref", ref: "comp" }] },
    ],
  } as unknown as PenDocument;
  const fill = (d: PenDocument): unknown => (d.children[0] as PenNode & { fill?: unknown }).fill;
  assert.equal(fill(prepareDocument(doc, "frame", { mode: "dark" })), "#000000");
  assert.equal(fill(prepareDocument(doc, "frame")), "#ffffff");
});
