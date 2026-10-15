import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { diffFrame, diffVariables, loadPenFile, matchFrames, type PenDocument, type PenNode } from "../src/index.js";
import { fixtureUrl } from "./helpers/fixtures.js";
import { loadExpected, type ExpectedEntry } from "./helpers/expected.js";

const load = (side: "base" | "head", file: string): Promise<PenDocument> =>
  loadPenFile(fileURLToPath(fixtureUrl(`${side}/${file}`)));

async function frameDiff(file: string, frameId: string) {
  const [base, head] = [await load("base", file), await load("head", file)];
  const m = matchFrames(base.children, head.children);
  const pair = m.pairs.find((p) => p.head.id === frameId);
  assert.ok(pair, `frame ${frameId} paired`);
  assert.equal(pair.matchedBy, expectedFor(file, frameId).matchedBy);
  return diffFrame(pair.base, pair.head, pair.matchedBy);
}

function expectedFor(file: string, frameId: string): ExpectedEntry {
  const e = loadExpected().find((x) => x.file === file && x.frameId === frameId);
  assert.ok(e, `expected entry for ${file}/${frameId}`);
  return e;
}

const NODE_FIXTURES = [
  "fill.pen",
  "text.pen",
  "node-added.pen",
  "node-removed.pen",
  "node-moved.pen",
  "node-reordered.pen",
  "instance-override.pen",
  "id-recreated-changed.pen",
];

for (const file of NODE_FIXTURES) {
  test(`fixture edit ${file} yields exactly the expected change`, async () => {
    const e = loadExpected().find((x) => x.file === file)!;
    const { nodes, counts } = await frameDiff(file, e.frameId);
    assert.equal(nodes.length, 1, JSON.stringify(nodes));
    const n = nodes[0]!;
    assert.equal(n.id, e.nodeId);
    assert.equal(n.change, e.change);
    assert.deepEqual(n.props?.map((p) => p.path), e.path ? [e.path] : undefined);
    assert.equal(counts[e.change as keyof typeof counts], 1);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 1);
  });
}

test("colour and text changes carry old and new values", async () => {
  const fill = (await frameDiff("fill.pen", "fill-frame")).nodes[0]!;
  assert.deepEqual(fill.props, [{ path: "fill", old: "#ff0000", new: "#00ff00" }]);
  const text = (await frameDiff("text.pen", "text-frame")).nodes[0]!;
  assert.deepEqual(text.props, [{ path: "content", old: "Hello", new: "World" }]);
});

test("a moved node reports old and new parent", async () => {
  const n = (await frameDiff("node-moved.pen", "moved-frame")).nodes[0]!;
  assert.deepEqual([n.from, n.to], ["group-a", "group-b"]);
});

test("instance override is a modification of the instance with the override path", async () => {
  const n = (await frameDiff("instance-override.pen", "override-frame")).nodes[0]!;
  assert.deepEqual(n.props, [{ path: "descendants.label.fill", old: "#112233", new: "#445566" }]);
});

test("id recreation matched by structure has no added/removed/modified nodes", async () => {
  const { nodes, counts } = await frameDiff("id-recreated.pen", "recreated-new");
  assert.deepEqual(nodes, []);
  assert.deepEqual(counts, { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 });
});

const box = (id: string): PenNode => ({ id, type: "rectangle", name: id });
const frame = (children: PenNode[]): PenNode => ({ id: "f", type: "frame", name: "F", children });

test("inserting an earlier sibling is not a reorder", () => {
  const { nodes } = diffFrame(frame([box("a"), box("b")]), frame([box("n"), box("a"), box("b")]), "id");
  assert.deepEqual(nodes.map((n) => [n.id, n.change]), [["n", "added"]]);
});

test("removing an earlier sibling is not a reorder", () => {
  const { nodes } = diffFrame(frame([box("a"), box("b"), box("c")]), frame([box("b"), box("c")]), "id");
  assert.deepEqual(nodes.map((n) => [n.id, n.change]), [["a", "removed"]]);
});

test("a node with several changes yields one entry per change, ordered by id then kind", () => {
  const base = frame([{ id: "g1", type: "frame", name: "G1", children: [{ ...box("x"), fill: "#111111" }] }, { id: "g2", type: "frame", name: "G2" }]);
  const head = frame([{ id: "g1", type: "frame", name: "G1" }, { id: "g2", type: "frame", name: "G2", children: [{ ...box("x"), fill: "#222222" }] }]);
  const { nodes, counts } = diffFrame(base, head, "id");
  assert.deepEqual(nodes.map((n) => [n.id, n.change]), [["x", "modified"], ["x", "moved"]]);
  assert.deepEqual(counts, { added: 0, removed: 0, modified: 1, moved: 1, reordered: 0 });
});

const variableExpected = loadExpected().filter((e) => e.variable);

test("variable change per theme lists the frames using it, including via a component", async () => {
  const [base, head] = [await load("base", "variable.pen"), await load("head", "variable.pen")];
  const { variables, themes } = diffVariables({ "variable.pen": { base, head } });
  assert.deepEqual(themes, []);
  assert.equal(variables.length, 1);
  const v = variables[0]!;
  assert.deepEqual([v.name, v.change, v.theme, v.old, v.new], ["bg", "modified", "mode=dark", "#000000", "#111111"]);
  assert.deepEqual(
    v.frames,
    variableExpected.map((e) => ({ file: e.file, frameId: e.frameId })).sort((a, b) => (a.frameId < b.frameId ? -1 : 1)),
  );
  assert.ok(!v.frames.some((f) => f.frameId === "var-none-frame"));
});

test("added and removed variables and theme axes are reported", async () => {
  const doc = await load("base", "variable.pen");
  const bare: PenDocument = { ...doc, variables: {}, themes: {} };
  const removed = diffVariables({ "variable.pen": { base: doc, head: bare } });
  assert.deepEqual(removed.variables.map((v) => [v.name, v.change, v.theme]), [["bg", "removed", "mode=dark"], ["bg", "removed", "mode=light"]]);
  assert.deepEqual(removed.themes.map((t) => [t.name, t.change]), [["mode", "removed"]]);
  const added = diffVariables({ "variable.pen": { base: bare, head: doc } });
  assert.deepEqual(added.variables.map((v) => [v.name, v.change, v.old]), [["bg", "added", undefined], ["bg", "added", undefined]]);
  assert.deepEqual(added.themes.map((t) => [t.name, t.change]), [["mode", "added"]]);
  assert.equal(added.variables[0]!.frames.length, 3);
});
