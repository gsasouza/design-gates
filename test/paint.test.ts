import { test } from "node:test";
import assert from "node:assert/strict";
import { gradientStops, loadPenFile, solidColor, type PenFill } from "../src/index.js";
import { gateFixture } from "./helpers/gates.js";

const doc = await loadPenFile(gateFixture("compile/paints.pen"));
const fillOf = (id: string): PenFill | undefined => doc.children.find((n) => n.id === id)?.fill as PenFill | undefined;

test("solidColor reads hex, variable, object and list fills", () => {
  assert.equal(solidColor(fillOf("hex")), "#112233");
  assert.equal(solidColor(fillOf("var")), "$brand");
  assert.equal(solidColor(fillOf("obj")), "#445566");
  // top-most visible entry wins; the disabled one is skipped
  assert.equal(solidColor(fillOf("list")), "#778899");
  assert.equal(solidColor(undefined), undefined);
});

test("solidColor is undefined for gradients and images", () => {
  for (const id of ["linear", "radial", "image"]) assert.equal(solidColor(fillOf(id)), undefined, id);
});

test("gradientStops reads stops and colors, and only for gradients", () => {
  assert.deepEqual(gradientStops(fillOf("linear")), [
    { color: "#000000", position: 0 },
    { color: "#FFFFFF", position: 1 },
  ]);
  assert.deepEqual(gradientStops(fillOf("radial"))?.map((s) => s.color), ["#FF0000", "#0000FF"]);
  for (const id of ["hex", "var", "obj", "list", "image"]) assert.equal(gradientStops(fillOf(id)), undefined, id);
});
