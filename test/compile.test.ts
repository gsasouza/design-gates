import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, getNode, listComponents, listInstances, loadPenFile, topFrameOf, type PenDocument, type PenNode } from "../src/index.js";
import { bakeVariables } from "../src/render/themes.js";
import { compileFixture, gateFixture, node } from "./helpers/gates.js";

const codes = (c: { diagnostics: { code: string; nodeId: string }[] }): string[] => c.diagnostics.map((d) => `${d.code}@${d.nodeId}`);

test("instances expand with descendants overrides, nested instances and provenance", async () => {
  const c = await compileFixture("compile/instances.pen");
  const c1 = node(c, "c1");
  assert.equal(c1.type, "frame");
  assert.equal(c1.instanceOf, "card");
  assert.equal(c1.props.width, 200);
  assert.equal(c1.props.fill, "#F0F0F0");
  assert.equal(c1.props.x, 10);
  for (const key of ["ref", "reusable", "descendants", "id"]) assert.ok(!(key in c1.props), key);
  assert.deepEqual(c1.provenance.width, { origin: "component", sourceNodeId: "card" });
  assert.deepEqual(c1.provenance.fill, { origin: "instance" });
  assert.deepEqual(c1.provenance.x, { origin: "instance" });

  const title = node(c, "c1::title");
  assert.deepEqual([title.props.fill, title.props.content], ["#FF0000", "Hi"]);
  assert.deepEqual(title.provenance.fill, { origin: "instance" });
  assert.equal(title.source, "title");
  assert.equal(title.path, "screen/c1/title");
  assert.deepEqual(title.provenance.type, undefined);

  // Nested instance: the outer override wins over the inner one.
  assert.equal(node(c, "c1::bdg").instanceOf, "badge");
  assert.deepEqual(node(c, "c1::bdg").provenance.x, { origin: "component", sourceNodeId: "bdg" });
  assert.equal(node(c, "c1::bdg::dot").props.fill, "#00FF00");
  assert.deepEqual(node(c, "c1::bdg::dot").provenance.fill, { origin: "instance" });
  assert.equal(node(c, "c2::bdg::dot").props.fill, "#00AA00");
  assert.deepEqual(node(c, "c2::bdg::dot").provenance.fill, { origin: "component", sourceNodeId: "bdg" });
  assert.deepEqual(node(c, "c2::bdg::dot").provenance.width, { origin: "component", sourceNodeId: "dot" });
  assert.ok(c.nodes.every((n) => !n.id.includes("/")));
  assert.deepEqual(c.diagnostics.map((d) => [d.rule, d.code, d.nodeId, d.prop]), [["SCH-002", "descendant-missing", "c1", "nope/x"]]);
});

test("component helpers", async () => {
  const c = await compileFixture("compile/instances.pen");
  assert.deepEqual(listComponents(c).map((n) => n.id), ["badge", "card"]);
  assert.deepEqual(listInstances(c, "card"), ["c1", "c2"]);
  assert.deepEqual(listInstances(c, "badge"), ["c1", "c2"]);
  assert.equal(topFrameOf(c, "c1::bdg::dot")?.id, "screen");
  assert.equal(getNode(c, "c2")?.parentId, "screen");
  assert.deepEqual(node(c, "c2::bdg::dot").parents, ["screen", "c2", "c2::bdg"]);
});

test("effective theme follows inherited pins, including a pin on an instance", async () => {
  const c = await compileFixture("compile/themes.pen");
  const t = (id: string): string => node(c, id).themeKey;
  assert.equal(t("plain"), "density=cozy,mode=light");
  assert.equal(t("plain-btn::btn-label"), "density=cozy,mode=light");
  assert.equal(t("plain-pinned-btn"), "density=cozy,mode=dark");
  assert.equal(t("plain-pinned-btn::btn-label"), "density=cozy,mode=dark");
  assert.equal(t("dark"), "density=cozy,mode=dark");
  assert.equal(t("dark-btn::btn-label"), "density=cozy,mode=dark");
  assert.equal(t("inner-leaf"), "density=compact,mode=dark");
  assert.equal(t("light-again"), "density=cozy,mode=light");
  assert.deepEqual(node(c, "inner-leaf").theme, { density: "compact", mode: "dark" });
});

test("alias chains resolve per theme; cycles and bad references are diagnostics", async () => {
  const c = await compileFixture("compile/themes.pen");
  const use = (id: string) => node(c, id).uses.find((u) => u.prop === "fill");
  assert.deepEqual(use("plain"), { prop: "fill", name: "brand", status: "ok", value: "#111111", chain: ["brand", "accent", "primary"] });
  assert.equal(use("plain-pinned-btn")?.value, "#EEEEEE");
  assert.equal(use("plain-pinned-btn::btn-label")?.value, "#EEEEEE");
  assert.equal(use("dark")?.value, "#EEEEEE");
  assert.equal(use("light-again")?.value, "#111111");
  assert.equal(node(c, "cycle").uses.find((u) => u.prop === "stroke.fill")?.value, "#111111");
  assert.equal(use("partial")?.status, "no-value");
  assert.equal(use("missing")?.status, "undefined");
  assert.deepEqual(
    c.diagnostics.map((d) => [d.rule, d.code, d.nodeId, d.prop]),
    [
      ["SCH-003", "variable-cycle", "cycle", "fill"],
      ["SCH-003", "escaped-variable", "escaped", "content"],
      ["SCH-003", "undefined-variable", "missing", "fill"],
    ],
  );
  assert.equal(c.diagnostics.find((d) => d.code === "variable-cycle")?.message, "Variable alias cycle: $loop-a -> $loop-b -> $loop-a");
});

test("the renderer wrapper still throws on an alias cycle", async () => {
  const doc = await loadPenFile(gateFixture("compile/themes.pen"));
  assert.throws(() => bakeVariables({ fill: "$loop-a" }, doc.variables ?? {}, {}), { message: "Variable alias cycle: $loop-a -> $loop-b -> $loop-a" });
});

test("ref cycles, missing and non-reusable refs are diagnostics and expansion terminates", async () => {
  const c = await compileFixture("compile/ref-cycle.pen");
  assert.deepEqual(codes(c), [
    "ref-cycle@a-b",
    "ref-cycle@b-a",
    "ref-cycle@self-ref",
    "ref-missing@use-missing",
    "ref-not-reusable@use-plain",
  ]);
  assert.equal(c.diagnostics.find((d) => d.nodeId === "b-a")?.message, "Instance reference cycle: A -> B -> A");
  assert.ok(c.diagnostics.every((d) => d.rule === "SCH-002"));
  assert.ok(c.nodes.length < 30);
});

test("duplicate id, id with slash, unknown type and unknown version are diagnostics", async () => {
  const c = await compileFixture("compile/schema.pen");
  assert.deepEqual(
    c.diagnostics.map((d) => [d.rule, d.code, d.nodeId]),
    [
      ["SCH-001", "unknown-version", ""],
      ["SCH-001", "id-contains-slash", "a%2Fb"],
      ["SCH-001", "duplicate-id", "dup~2"],
      ["SCH-001", "unknown-type", "weird"],
    ],
  );
  assert.equal(new Set(c.nodes.map((n) => n.id)).size, c.nodes.length);
  assert.equal(node(c, "a%2Fb").sourceId, "a/b");
  assert.equal(node(c, "a%2Fb").path, "f/a%2Fb");
});

test("malformed documents never throw", () => {
  const bad = { version: 3, children: [null, 4, { id: 1, type: null, children: "x" }, { type: "ref", ref: 7 }], variables: [], themes: 5 };
  const c = compile(bad as unknown as PenDocument);
  assert.ok(c.diagnostics.some((d) => d.code === "unknown-version"));
  assert.doesNotThrow(() => compile({} as PenDocument));
});

test("expansion is bounded by a node budget and nesting by a depth guard", () => {
  // 10 instances per level, 20 levels: exponential without a budget.
  const doc: PenDocument = { version: "2.6", children: [{ id: "c0", type: "frame", reusable: true }] };
  for (let level = 1; level <= 20; level++) {
    doc.children.push({
      id: `c${level}`,
      type: "frame",
      reusable: true,
      children: Array.from({ length: 10 }, (_, i) => ({ id: `i${level}-${i}`, type: "ref", ref: `c${level - 1}` })),
    });
  }
  doc.children.push({ id: "top", type: "frame", children: [{ id: "use", type: "ref", ref: "c20" }] });
  const c = compile(doc);
  assert.ok(c.nodes.length <= 100_000);
  assert.ok(c.diagnostics.some((d) => d.code === "node-budget" || d.code === "ref-depth"));

  let deep: PenNode = { id: "leaf", type: "frame" };
  for (let i = 0; i < 5000; i++) deep = { id: `n${i}`, type: "frame", children: [deep] };
  const d = compile({ version: "2.6", children: [deep] });
  assert.ok(d.diagnostics.some((x) => x.code === "too-deep" && x.rule === "SCH-001"));
  assert.ok(d.nodes.length < 200);
});

test("compiling is deterministic and leaves the document untouched", async () => {
  for (const name of ["instances", "themes", "ref-cycle", "schema"]) {
    const doc = await loadPenFile(gateFixture(`compile/${name}.pen`));
    const before = JSON.stringify(doc);
    const a = compile(doc, { file: `${name}.pen` });
    const b = compile(structuredClone(doc), { file: `${name}.pen` });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(JSON.stringify(doc), before);
  }
});
