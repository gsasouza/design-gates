import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPenFile } from "../src/index.js";
import { withFrameTheme } from "../src/render/themes.js";
import { fixtureUrl } from "./helpers/fixtures.js";

const themed = await loadPenFile(fixtureUrl("spike/themed.pen").pathname);

test("withFrameTheme returns a deep copy carrying the theme on the frame", () => {
  const copy = withFrameTheme(themed, "frame", { mode: "dark" });
  assert.notEqual(copy, themed);
  assert.notEqual(copy.children[0], themed.children[0]);
  assert.deepEqual(copy.children[0]?.theme, { mode: "dark" });
});

test("withFrameTheme leaves the original document untouched", () => {
  const before = JSON.stringify(themed);
  const copy = withFrameTheme(themed, "frame", { mode: "dark" });
  copy.children[0]!.width = 1;
  assert.equal(JSON.stringify(themed), before);
  assert.equal(themed.children[0]?.theme, undefined);
});

test("withFrameTheme without a theme still deep-copies", () => {
  const copy = withFrameTheme(themed, "frame");
  assert.deepEqual(copy, themed);
  assert.notEqual(copy.children[0], themed.children[0]);
});

test("withFrameTheme throws for an unknown frame", () => {
  assert.throws(() => withFrameTheme(themed, "nope", { mode: "dark" }), /Frame not found: nope/);
});
