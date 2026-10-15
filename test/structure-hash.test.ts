import { test } from "node:test";
import assert from "node:assert/strict";
import { structureHash, type PenNode } from "../src/index.js";

const card = (over: { fill?: string; label?: string; text?: string; id?: string; x?: number } = {}): PenNode => ({
  id: over.id ?? "card",
  type: "frame",
  name: "Card",
  x: over.x ?? 0,
  y: 0,
  fill: over.fill ?? "#FFFFFF",
  cornerRadius: 8,
  children: [{ id: "t", type: "text", name: over.label ?? "title", content: over.text ?? "Hello", fill: "#000000" }],
});

test("default mode is unchanged: type, name and text content only", () => {
  assert.equal(
    structureHash(card()),
    JSON.stringify(["frame", "Card", [["text", "title", "Hello", []]]]),
  );
  assert.equal(structureHash(card()), structureHash(card({ fill: "#000000", id: "other", x: 9 })));
  assert.notEqual(structureHash(card()), structureHash(card({ text: "Bye" })));
  assert.equal(structureHash(card(), {}), structureHash(card()));
});

test("component mode: a different fill does not match", () => {
  const opts = { mode: "component" } as const;
  assert.notEqual(structureHash(card(), opts), structureHash(card({ fill: "#000000" }), opts));
});

test("component mode: renamed children, different text, ids and positions still match", () => {
  const opts = { mode: "component" } as const;
  assert.equal(structureHash(card(), opts), structureHash(card({ label: "heading", text: "Other", id: "copy", x: 40 }), opts));
});

test("component mode ignores property order and metadata but not other props", () => {
  const opts = { mode: "component" } as const;
  const a: PenNode = { id: "a", type: "frame", stroke: { fill: "#000", thickness: 1 }, metadata: { n: 1 } };
  const b: PenNode = { type: "frame", id: "b", metadata: { n: 2 }, stroke: { thickness: 1, fill: "#000" } };
  assert.equal(structureHash(a, opts), structureHash(b, opts));
  assert.notEqual(structureHash(a, opts), structureHash({ ...b, stroke: { thickness: 2, fill: "#000" } }, opts));
  assert.notEqual(structureHash(a, opts), structureHash({ ...b, type: "group" }, opts));
});

test("component mode: a reusable component equals its detached copy", () => {
  const opts = { mode: "component" } as const;
  const component: PenNode = { ...card(), reusable: true };
  const copy = card({ label: "heading", text: "Other", id: "copy", x: 40 });
  assert.equal(structureHash(component, opts), structureHash(copy, opts));
});
