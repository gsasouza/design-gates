import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SceneGraph, type SceneNode } from "@open-pencil/core";
import { compile } from "../src/compile/compile.js";
import { DEFAULT_CONFIG } from "../src/gates/config.js";
import type { RuleId } from "../src/gates/config.js";
import type { PenDocument } from "../src/pen/types.js";
import { runRules, type RuleEntry } from "../src/rules/index.js";
import { createOpenPencilRenderer } from "../src/render/openpencil.js";
import { checkKiwiInflation } from "../src/source/inflate-cap.js";
import { emittedIdMap } from "../src/source/ids.js";
import { loadDesignSource } from "../src/source/load.js";
import { writeFig } from "./helpers/fig-fixtures.js";

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("severity override on a fig-only node", () => {
  it("a warn rule raised to block is a review with a fixed severity on a fig-only node, a block on a plain one", () => {
    const doc = {
      version: "2.6",
      children: [{ id: "f", type: "frame", children: [{ id: "odd", type: "rectangle", figType: "STAR" }, { id: "plain", type: "frame" }] }],
    } as PenDocument;
    const compiled = compile(doc, { file: "a.fig", format: "fig", figVersion: 1 });
    const warnRule: RuleEntry = {
      id: "TOK-001" as RuleId,
      title: "fake",
      description: "fake",
      defaultSeverity: "warn",
      run: () => ["odd", "plain"].map((nodeId) => ({ rule: "TOK-001", severity: "warn", file: "", nodeId, path: nodeId, message: "hard-coded" })),
    };
    const config = { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "TOK-001": { ...DEFAULT_CONFIG.rules["TOK-001"], severity: "block" as const } } };
    const out = runRules([{ file: "a.fig", compiled }], config, [warnRule]);
    assert.deepEqual(out.map((v) => [v.nodeId, v.severity, v.fixedSeverity]), [
      ["odd", "review", true],
      ["plain", "block", undefined],
    ]);
  });
});

describe("zstd chunk cap", () => {
  /** A bare fig-kiwi blob whose only chunk is the given zstd frame. */
  const blobOf = (frame: Buffer): Buffer => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(frame.length);
    return Buffer.concat([Buffer.from("fig-kiwi"), Buffer.alloc(4), size, frame]);
  };
  const lastEmptyBlock = Buffer.from([1, 0, 0]);

  it("rejects a frame declaring a content size over the cap", async () => {
    const declared = Buffer.alloc(4);
    declared.writeUInt32LE(0x7fffffff);
    const frame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0]), declared, lastEmptyBlock]);
    await assert.rejects(loadDesignSource("z.fig", blobOf(frame)), /Invalid \.fig document: .*MAX_FIG_CHUNK_BYTES/);
  });

  it("accepts a frame that does not declare its content size while its output stays under the cap", async () => {
    const frame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]), lastEmptyBlock]);
    await checkKiwiInflation(blobOf(frame), 2000, () => assert.fail("over the cap"));
  });
});

describe("two collections with the same name", () => {
  it("renders the second collection's mode through its deduplicated axis name", async () => {
    const g = new SceneGraph();
    const page = g.getPages()[0]!;
    const first = g.createCollection("Theme");
    const second = g.createCollection("Theme");
    const light = second.defaultModeId;
    g.renameMode(second.id, light, "Light");
    const dark = g.createMode(second.id, "Dark")!;
    const fg = g.createVariable("fg", "COLOR", second.id, WHITE);
    fg.valuesByMode = { [light]: WHITE, [dark]: BLACK };
    assert.notEqual(first.id, second.id);
    const frame = g.createNode("FRAME", page.id, { name: "Screen", width: 20, height: 20, fills: [{ type: "SOLID", color: WHITE, opacity: 1, visible: true }] });
    g.updateNode(frame.id, { variableModes: { [second.id]: light } });
    g.bindVariable(frame.id, "fills/0/color", fg.id);

    const source = await loadDesignSource("t.fig", Buffer.from(await writeFig(g)));
    assert.deepEqual(source.doc.themes, { Theme: ["Mode 1"], "Theme-2": ["Light", "Dark"] });
    const screen = source.doc.children.find((n) => n.name === "Screen")!;
    const renderer = createOpenPencilRenderer();
    const plain = await renderer.renderSource!(source, screen.id, { scale: 1 });
    const dark2 = await renderer.renderSource!(source, screen.id, { scale: 1, theme: { "Theme-2": "Dark" } });
    const again = await renderer.renderSource!(source, screen.id, { scale: 1 });
    assert.ok(!plain.png.equals(dark2.png));
    assert.ok(again.png.equals(plain.png));
  });
});

describe("emitted id check", () => {
  const emitted = (...pairs: Array<[string, string]>): Array<[string, string]> => pairs;

  it("fails on two emitted nodes with one id", () => {
    assert.throws(() => emittedIdMap(emitted(["1:5", "a"], ["1:5", "b"])), /two nodes with the id 1:5/);
  });

  it("lets a node that is never emitted share a fallback id with a GUID", () => {
    const ids = emittedIdMap(emitted(["1:5", "g"]));
    assert.deepEqual([...ids], [["1:5", "g"]]);
  });
});
