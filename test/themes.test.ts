import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPenFile } from "../src/index.js";
import { defaultTheme, findNode, prepareDocument, resolveVariable, withFrameTheme } from "../src/render/themes.js";
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

test("prepareDocument bakes a component with the theme of an instance under a nested pin", () => {
  const doc = {
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables: { c: two },
    children: [
      { id: "comp", type: "rectangle", reusable: true, width: 1, height: 1, fill: "$c" },
      {
        id: "frame",
        type: "frame",
        width: 10,
        height: 10,
        children: [
          { id: "plain", type: "ref", ref: "comp" },
          { id: "box", type: "frame", theme: { mode: "dark" }, children: [{ id: "dark", type: "ref", ref: "comp" }] },
        ],
      },
    ],
  } as unknown as Doc;
  const out = prepareDocument(doc, "frame");
  const byId = (id: string) => out.children.find((n) => n.id === id) as unknown as { fill?: unknown; ref?: string };
  const frame = out.children.find((n) => n.id === "frame")!;
  const plain = frame.children![0] as unknown as { ref: string };
  const dark = frame.children![1]!.children![0] as unknown as { ref: string };
  assert.equal(plain.ref, "comp");
  assert.equal(byId("comp").fill, "#111111");
  assert.notEqual(dark.ref, "comp");
  assert.equal(byId(dark.ref).fill, "#222222");
});

const nestedDoc = (descendants: Record<string, unknown>): Doc =>
  ({
    version: "2.6",
    themes: { mode: ["light", "dark"] },
    variables: { c: { type: "color", value: [{ value: "#ffffff" }, { value: "#000000", theme: { mode: "dark" } }] } },
    children: [
      { id: "B", type: "frame", reusable: true, width: 10, height: 10, children: [{ id: "dot", type: "rectangle", width: 4, height: 4, fill: "$c" }] },
      { id: "A", type: "frame", reusable: true, width: 10, height: 10, children: [{ id: "b-inst", type: "ref", ref: "B" }] },
      {
        id: "frame",
        type: "frame",
        width: 40,
        height: 20,
        children: [{ id: "dark-pin", type: "frame", theme: { mode: "dark" }, children: [{ id: "a-inst", type: "ref", ref: "A", descendants }] }],
      },
    ],
  }) as unknown as Doc;

test("prepareDocument maps each override path segment through the variant that holds it", async () => {
  const { compile } = await import("../src/compile/compile.js");
  const prepared = prepareDocument(nestedDoc({ "b-inst/dot": { fill: "#ff0000" } }), "frame");
  const inst = findNode(prepared.children, "a-inst")!;
  const outer = findNode(prepared.children, String(inst.ref))!;
  const nested = findNode(prepared.children, String(outer.children![0]!.ref))!;
  const dot = nested.children![0]!.id;
  assert.notEqual(nested.id, "B");
  assert.deepEqual(Object.keys(inst.descendants!), [`${outer.children![0]!.id}/${dot}`]);
  const result = compile(prepared);
  assert.ok(!result.diagnostics.some((d) => d.code === "descendant-missing"));
  const target = result.nodes.find((n) => n.path.includes("a-inst") && n.sourceId === dot);
  assert.ok(target);
  assert.equal(target.props.fill, "#ff0000");
});

test("prepareDocument still suffixes a single-segment override path", () => {
  const prepared = prepareDocument(nestedDoc({ "b-inst": { opacity: 0.5 } }), "frame");
  const inst = findNode(prepared.children, "a-inst")!;
  const outer = findNode(prepared.children, String(inst.ref))!;
  assert.deepEqual(Object.keys(inst.descendants!), [outer.children![0]!.id]);
});

test("prepareDocument gives unresolvable segments after a nested instance the outer suffix", () => {
  const prepared = prepareDocument(nestedDoc({ "b-inst/missing/deeper": { opacity: 0.5 } }), "frame");
  const inst = findNode(prepared.children, "a-inst")!;
  const outer = findNode(prepared.children, String(inst.ref))!;
  const nestedRef = String(outer.children![0]!.ref);
  const outerSuffix = String(inst.ref).slice(String(inst.ref).lastIndexOf("@"));
  assert.notEqual(nestedRef.slice(nestedRef.lastIndexOf("@")), outerSuffix);
  assert.deepEqual(Object.keys(inst.descendants!), [`${outer.children![0]!.id}/missing${nestedRef.slice(nestedRef.lastIndexOf("@"))}/deeper${outerSuffix}`]);
});
