import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeDiff, type DiffResult, type FrameDiff } from "../src/index.js";

const frame = (id: string, extra: Partial<FrameDiff> = {}): FrameDiff => ({
  id,
  name: id,
  headId: id,
  baseId: id,
  status: "modified",
  matchedBy: "id",
  counts: { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 },
  nodes: [],
  changeBoxes: [],
  missingBoxes: [],
  pixelDiffRatio: null,
  images: null,
  ...extra,
});

const sample = (): DiffResult => ({
  schemaVersion: 1,
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "HEAD", sha: "WORKTREE" },
  files: [
    {
      path: "b.pen",
      status: "modified",
      frames: [
        frame("f2"),
        frame("f1", {
          nodes: [
            { id: "n2", name: "N2", type: "rectangle", change: "modified", props: [{ path: "fill", old: { b: 1, a: 2 }, new: "x" }] },
            { id: "n1", name: "N1", type: "rectangle", change: "moved", from: "p", to: "q" },
            { id: "n1", name: "N1", type: "rectangle", change: "added" },
            { id: "n1", name: "N1", type: "rectangle", change: "reordered" },
            { id: "n1", name: "N1", type: "rectangle", change: "removed" },
          ],
          pixelDiffRatio: { "mode=dark": 0.5, default: 0.1, "mode=aa": 0 },
          images: { "mode=dark": { diff: "d", base: "b" }, default: { head: "h" } },
        }),
      ],
    },
    { path: "a.pen", oldPath: "z.pen", status: "renamed", frames: [] },
  ],
  variables: [
    { file: "b.pen", name: "z", change: "added", new: 1, frames: [{ file: "b.pen", frameId: "f2" }, { file: "a.pen", frameId: "f1" }] },
    { file: "a.pen", name: "y", change: "modified", theme: "mode=dark", old: 1, new: 2, frames: [] },
  ],
  themes: [
    { file: "b.pen", name: "mode", change: "added", frames: [] },
    { file: "a.pen", name: "mode", change: "removed", frames: [] },
  ],
});

test("serializeDiff sorts files, frames, nodes, variables and themes", () => {
  const out = JSON.parse(serializeDiff(sample()));
  assert.deepEqual(out.files.map((f: { path: string }) => f.path), ["a.pen", "b.pen"]);
  assert.deepEqual(out.files[1].frames.map((f: { id: string }) => f.id), ["f1", "f2"]);
  assert.deepEqual(
    out.files[1].frames[0].nodes.map((n: { id: string; change: string }) => `${n.id}:${n.change}`),
    ["n1:added", "n1:removed", "n1:moved", "n1:reordered", "n2:modified"],
  );
  assert.deepEqual(out.variables.map((v: { name: string }) => v.name), ["y", "z"]);
  assert.deepEqual(out.variables[1].frames.map((f: { file: string }) => f.file), ["a.pen", "b.pen"]);
  assert.deepEqual(out.themes.map((t: { file: string }) => t.file), ["a.pen", "b.pen"]);
});

test("serializeDiff orders per-theme keys with default first", () => {
  const out = JSON.parse(serializeDiff(sample()));
  const f1 = out.files[1].frames[0];
  assert.deepEqual(Object.keys(f1.pixelDiffRatio), ["default", "mode=aa", "mode=dark"]);
  assert.deepEqual(Object.keys(f1.images), ["default", "mode=dark"]);
  assert.deepEqual(Object.keys(f1.images["mode=dark"]), ["base", "diff"]);
});

test("serializeDiff uses a fixed object key order", () => {
  const out = JSON.parse(serializeDiff(sample()));
  assert.deepEqual(Object.keys(out), ["schemaVersion", "base", "head", "files", "variables", "themes"]);
  assert.deepEqual(Object.keys(out.files[0]), ["path", "oldPath", "status", "frames"]);
  assert.deepEqual(Object.keys(out.files[1].frames[0]), [
    "id", "name", "baseId", "headId", "status", "matchedBy", "counts",
    "nodes", "changeBoxes", "missingBoxes", "pixelDiffRatio", "images",
  ]);
  assert.deepEqual(Object.keys(out.files[1].frames[0].counts), ["added", "removed", "modified", "moved", "reordered"]);
  assert.deepEqual(Object.keys(out.files[1].frames[0].nodes[4].props[0]), ["path", "old", "new"]);
  assert.deepEqual(Object.keys(out.files[1].frames[0].nodes[4].props[0].old), ["a", "b"]);
});

test("serializeDiff ends with one newline, uses 2-space indent and is identical for shuffled input", () => {
  const a = sample();
  const text = serializeDiff(a);
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
  assert.ok(text.startsWith('{\n  "schemaVersion": 1,\n'));
  const b = sample();
  b.files.reverse();
  for (const f of b.files) {
    f.frames.reverse();
    for (const fr of f.frames) fr.nodes.reverse();
  }
  b.variables.reverse();
  b.themes.reverse();
  b.variables[0]!.frames.reverse();
  assert.equal(serializeDiff(b), text);
});
