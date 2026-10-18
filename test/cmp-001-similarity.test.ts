import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, DEFAULT_CONFIG, parsePen, registry, resolveConfig, type GatesConfig, type Violation } from "../src/index.js";
import { baxterSimilarity } from "../src/diff/similarity.js";
import type { PenNode } from "../src/pen/types.js";
import { gateFixture } from "./helpers/gates.js";

type N = Record<string, unknown>;
const cfg = (similarity?: number, minNodes?: number): GatesConfig => {
  const r = resolveConfig({ rules: { "CMP-001": { ...(similarity === undefined ? {} : { similarity }), ...(minNodes === undefined ? {} : { minNodes }) } } });
  assert.ok("config" in r);
  return r.config;
};
const run = (children: N[], config: GatesConfig): Violation[] =>
  registry.find((r) => r.id === "CMP-001")!.run(compile(parsePen(JSON.stringify({ version: "2.6", children })), { file: "t.pen" }), config);

const leaf = (id: string, extra: N = {}): N => ({ id, type: "ellipse", width: 16, height: 16, fill: "#FFFFFF", ...extra });
const button = (id: string, extra: N = {}, kids: N[] = [leaf(`${id}-i`), leaf(`${id}-j`)]): N => ({ id, type: "frame", width: 120, height: 40, fill: "#0055FF", children: kids, ...extra });
const component = (id = "button", kids?: N[]): N => button(id, { reusable: true }, kids);
// 3 nodes; one child differs in fill: shared 2, differing 1 on each side -> S = 4/6.
const nearCopy = (id: string): N => button(id, {}, [leaf(`${id}-i`), leaf(`${id}-j`, { fill: "#000000" })]);

const pen = (n: N): PenNode => n as unknown as PenNode;

test("similarity: identical trees score 1", () => {
  assert.equal(baxterSimilarity(pen(button("a")), pen(button("b"))), 1);
});

test("similarity: one differing prop scores 4/6", () => {
  assert.equal(baxterSimilarity(pen(nearCopy("a")), pen(button("b"))), 4 / 6);
});

test("similarity: an extra child and a missing child score 6/7", () => {
  const extra = button("a", {}, [leaf("1"), leaf("2"), leaf("3")]);
  assert.equal(baxterSimilarity(pen(extra), pen(button("b"))), 6 / 7);
  assert.equal(baxterSimilarity(pen(button("b")), pen(extra)), 6 / 7);
  const missing = button("c", {}, [leaf("1")]);
  assert.equal(baxterSimilarity(pen(missing), pen(button("b"))), 4 / 5);
});

test("similarity: a differing parent still aligns its children and unpaired subtrees count whole", () => {
  const a = button("a", { fill: "#111111" });
  assert.equal(baxterSimilarity(pen(a), pen(button("b"))), 4 / 6);
  const deep = button("d", {}, [leaf("1"), { ...button("2"), children: [leaf("x"), leaf("y")] }]);
  // shared: root and child 1; frame 2 vs ellipse differs (1 + 1) and frame 2's two children are unpaired (2).
  assert.equal(baxterSimilarity(pen(deep), pen(button("b"))), 4 / 8);
});

test("similarity: an unpaired child counts with all of its own children", () => {
  const withGrandkids = button("a", {}, [leaf("1"), leaf("2"), { ...button("3"), children: [leaf("x"), leaf("y")] }]);
  // shared: root and two leaves (3); the unpaired frame and its two children are 3 nodes only in a.
  assert.equal(baxterSimilarity(pen(withGrandkids), pen(button("b"))), (2 * 3) / (2 * 3 + 3));
  assert.equal(baxterSimilarity(pen(button("b")), pen(withGrandkids)), (2 * 3) / (2 * 3 + 3));
});

test("CMP-001 similarity: a near miss is reported at the threshold and silent above it", () => {
  const doc = [component(), nearCopy("copy")];
  const at = run(doc, cfg(4 / 6));
  assert.deepEqual(at.map((v) => [v.nodeId, v.severity, v.message, v.fix]), [["copy", "warn", 'Subtree is 67% similar to component "button"; use an instance instead', undefined]]);
  assert.deepEqual(run(doc, cfg(0.7)), []);
});

test("CMP-001 similarity: off by default", () => {
  assert.deepEqual(run([component(), nearCopy("copy")], DEFAULT_CONFIG), []);
});

test("CMP-001 similarity: exact output is unchanged when similarity is set", () => {
  const doc = [component(), button("copy")];
  const base = run(doc, DEFAULT_CONFIG);
  assert.equal(base.length, 1);
  assert.deepEqual(run(doc, cfg(0.5)), base);
});

test("CMP-001 similarity: exact fixture output is unchanged when similarity is set", async () => {
  const doc = parsePen(await readFile(gateFixture("CMP-001/text-copy.fail.pen"), "utf8"));
  const c = (config: GatesConfig) => registry.find((r) => r.id === "CMP-001")!.run(compile(doc, { file: "f.pen" }), config);
  assert.deepEqual(c(cfg(0.1)), c(DEFAULT_CONFIG));
});

test("CMP-001 similarity: a near-miss container around an exact copy keeps the exact match", () => {
  const wrapper: N = { id: "wrap", type: "frame", width: 300, height: 200, children: [button("exact"), leaf("extra1"), leaf("extra2")] };
  const doc = [component(), wrapper];
  const without = run(doc, DEFAULT_CONFIG);
  assert.deepEqual(without.map((v) => v.nodeId), ["exact"]);
  assert.deepEqual(run(doc, cfg(0.1)), without);
});

test("CMP-001 similarity: only the outermost near miss is reported", () => {
  const outer: N = button("outer", {}, [leaf("o1"), { ...button("inner", {}, [leaf("n1"), leaf("n2", { fill: "#000000" })]) }]);
  const v = run([component(), outer, nearCopy("lonely")], cfg(0.3));
  assert.deepEqual(v.map((x) => x.nodeId), ["outer", "lonely"]);
});

test("CMP-001 similarity: ties go to the smallest component id and the best score wins", () => {
  const v = run([component("b-comp"), component("a-comp"), nearCopy("copy")], cfg(0.5));
  assert.match(v[0]!.message, /component "a-comp"/);
  const better = run([component("a-comp", [leaf("1", { fill: "#222222" }), leaf("2", { fill: "#333333" })]), component("z-comp"), nearCopy("copy")], cfg(0.5));
  assert.equal(better.length, 1);
  assert.match(better[0]!.message, /component "z-comp"/);
});

test("CMP-001 similarity: the most similar component wins over a lower id", () => {
  const lowId = component("a-comp", [leaf("1"), leaf("2", { fill: "#222222" }), leaf("3", { fill: "#333333" })]);
  const highId = component("z-comp", [leaf("1"), leaf("2"), leaf("3")]);
  const copy = button("copy", {}, [leaf("1"), leaf("2"), leaf("3", { fill: "#000000" })]);
  const v = run([lowId, highId, copy], cfg(0.5));
  assert.deepEqual(v.map((x) => x.message), ['Subtree is 75% similar to component "z-comp"; use an instance instead']);
});

test("CMP-001 similarity: minNodes still applies", () => {
  const small: N = { id: "small", type: "frame", width: 120, height: 40, fill: "#0055FF", children: [leaf("s1")] };
  const comp: N = { id: "c", type: "frame", width: 120, height: 40, fill: "#0055FF", reusable: true, children: [leaf("c1", { fill: "#000000" })] };
  assert.deepEqual(run([comp, small], cfg(0.5, 3)), []);
  assert.equal(run([comp, small], cfg(0.5, 2)).length, 1);
});

test("CMP-001 similarity: near-miss fixtures (fail at 0.6, pass once the copy drifts further)", async () => {
  const c = async (name: string, config: GatesConfig) =>
    registry.find((r) => r.id === "CMP-001")!.run(compile(parsePen(await readFile(gateFixture(`CMP-001/${name}.pen`), "utf8")), { file: name }), config);
  assert.deepEqual((await c("near-miss.fail", cfg(0.6))).map((v) => [v.nodeId, v.message]), [["copy", 'Subtree is 67% similar to component "button"; use an instance instead']]);
  assert.deepEqual(await c("near-miss.pass", cfg(0.6)), []);
  assert.deepEqual(await c("near-miss.fail", DEFAULT_CONFIG), []);
});
