import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPenFile } from "../src/index.js";
import { defaultTheme, prepareDocument, resolveVariable, withFrameTheme } from "../src/render/themes.js";
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

type Doc = Parameters<typeof prepareDocument>[0];
const docWith = (variables: Record<string, unknown>, extra: Record<string, unknown> = {}): Doc =>
  ({
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables,
    children: [{ id: "frame", type: "frame", width: 10, height: 10, fill: "$c", ...extra }],
  }) as unknown as Doc;
const fillOf = (d: Doc): unknown => (d.children[0] as unknown as { fill?: unknown }).fill;
const two = { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#222222", theme: { mode: "dark" } }] };

test("prepareDocument deep-copies and leaves the original untouched", () => {
  const doc = docWith({ c: two });
  const before = JSON.stringify(doc);
  const out = prepareDocument(doc, "frame", { mode: "dark" });
  assert.equal(JSON.stringify(doc), before);
  assert.notEqual(out.children[0], doc.children[0]);
  assert.equal(fillOf(out), "#222222");
});

test("prepareDocument merges the frame theme pin with the one already on the frame", () => {
  const doc = docWith({ c: two }, { theme: { size: "big" } });
  assert.deepEqual(prepareDocument(doc, "frame", { mode: "dark" }).children[0]?.theme, { size: "big", mode: "dark" });
});

test("a nested node theme overrides the inherited theme", () => {
  const doc = docWith({ c: two });
  (doc.children[0] as unknown as { children: unknown[] }).children = [{ id: "inner", type: "rectangle", width: 1, height: 1, fill: "$c", theme: { mode: "light" } }];
  const out = prepareDocument(doc, "frame", { mode: "dark" });
  assert.equal(fillOf(out), "#222222");
  assert.equal((out.children[0]!.children![0] as unknown as { fill: unknown }).fill, "#111111");
});

test("the last satisfied entry wins, including a later unthemed entry", () => {
  const doc = docWith({ c: { type: "color", value: [{ value: "#aaaaaa", theme: { mode: "dark" } }, { value: "#bbbbbb" }] } });
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "dark" })), "#bbbbbb");
  assert.equal(resolveVariable({ type: "color", value: [{ value: "x" }, { value: "y", theme: { mode: "dark" } }] } as never, { mode: "light" }), "x");
});

test("alias chains resolve through two levels", () => {
  const doc = docWith({ c: { type: "color", value: "$b" }, b: { type: "color", value: "$a" }, a: two });
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "dark" })), "#222222");
  assert.equal(fillOf(prepareDocument(doc, "frame", { mode: "light" })), "#111111");
});

test("an alias cycle throws", () => {
  const doc = docWith({ c: { type: "color", value: "$b" }, b: { type: "color", value: "$c" } });
  assert.throws(() => prepareDocument(doc, "frame"), /alias cycle/);
});

test("defaultTheme picks the first value of each axis", () => {
  assert.deepEqual(defaultTheme({ mode: ["light", "dark"], size: ["s"] } as never), { mode: "light", size: "s" });
  assert.deepEqual(defaultTheme(undefined), {});
});

test("prepareDocument with an unknown frame returns a copy without throwing", () => {
  const doc = docWith({ c: two });
  assert.equal(fillOf(prepareDocument(doc, "nope", { mode: "dark" })), "#111111");
});
