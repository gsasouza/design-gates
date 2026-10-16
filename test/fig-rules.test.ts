import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile/compile.js";
import { KNOWN_FIG_VERSIONS } from "../src/compile/constants.js";
import { defaultFs } from "../src/cli/run-diff.js";
import { runCheck } from "../src/cli/run-check.js";
import { DEFAULT_CONFIG } from "../src/gates/config.js";
import type { RuleId } from "../src/gates/config.js";
import type { Violation } from "../src/gates/types.js";
import { computeSemanticDiff, serializeDiff } from "../src/index.js";
import type { PenDocument } from "../src/pen/types.js";
import { registry, runRules, type RuleEntry } from "../src/rules/index.js";
import { loadDesignSource } from "../src/source/load.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const FIG_VERSION = KNOWN_FIG_VERSIONS[0]!;
const figCompile = (doc: PenDocument, figVersion: number | undefined = FIG_VERSION) =>
  compile(doc, { file: "a.fig", format: "fig", ...(figVersion !== undefined && { figVersion }) });
const run = (compiled: ReturnType<typeof compile>, entries?: readonly RuleEntry[]): Violation[] =>
  runRules([{ file: "a.fig", compiled }], DEFAULT_CONFIG, entries);
const fixtureBytes = (name: string, side: string): Buffer => readFileSync(new URL(`../../fixtures/fig/${name}/${side}.fig`, import.meta.url));
const sch001 = (compiled: ReturnType<typeof compile>): Violation[] => run(compiled).filter((v) => v.rule === "SCH-001");

describe("SCH-001 on .pen and .fig", () => {
  it(".pen keeps the pen version check", () => {
    const out = runRules([{ file: "a.pen", compiled: compile({ version: "9.9", children: [] }, { file: "a.pen" }) }], DEFAULT_CONFIG);
    assert.deepEqual(out.map((v) => [v.rule, v.severity, v.message, v.fixedSeverity]), [
      ["SCH-001", "warn", 'Unknown document version "9.9"; the check ran in degraded mode', true],
    ]);
  });

  it("a valid .fig passes as its own format, whatever .pen version it normalized to", async () => {
    const source = await loadDesignSource("a.fig", fixtureBytes("solid-fill", "base"));
    assert.equal(source.format, "fig");
    assert.deepEqual(sch001(figCompile(source.doc, source.figVersion)), []);
    assert.deepEqual(sch001(figCompile({ ...source.doc, version: "0.0" }, source.figVersion)), []);
  });

  it("an unknown or unreported fig version is a warn with a fixed severity", () => {
    const doc: PenDocument = { version: "2.6", children: [] };
    const unknown = sch001(figCompile(doc, 7));
    assert.deepEqual(unknown.map((v) => [v.severity, v.message, v.fixedSeverity]), [
      ["warn", 'Unknown .fig version "7"; the check ran in degraded mode', true],
    ]);
    assert.deepEqual(sch001(compile(doc, { file: "a.fig", format: "fig" })).map((v) => v.message), ["Unknown .fig version not reported; the check ran in degraded mode"]);
  });

  it("a corrupt .fig is a parse failure through the check path", async () => {
    const repo = await createFixtureRepo({ base: "check/fig-base", head: "check/fig-head" });
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${repo.path}/card.fig`, Buffer.from("not a fig file"));
      let out = "";
      const code = await runCheck({}, { cwd: repo.path, stdout: (t) => (out += t), stderr: (t) => (out += t), fs: defaultFs });
      assert.equal(code, 1);
      const violations = (JSON.parse(out) as { violations: Violation[] }).violations;
      assert.equal(violations.length, 1);
      assert.deepEqual([violations[0]!.rule, violations[0]!.severity, violations[0]!.file], ["SCH-001", "block", "card.fig"]);
      assert.match(violations[0]!.message, /^Invalid \.fig document/);
    } finally {
      await repo.cleanup();
    }
  });
});

/** A fig document whose nodes the normalizer only approximated, with defects each schema rule would block on a .pen. */
const FIG_ONLY: PenDocument = {
  version: "2.6",
  children: [
    {
      id: "f",
      type: "frame",
      children: [
        { id: "grad", type: "rectangle", figType: "STAR", fill: "$nope" },
        { id: "odd", type: "hexagon", figType: "VECTOR" },
        { id: "use", type: "ref", ref: "ghost", figType: "INSTANCE" },
        { id: "img", type: "rectangle", fill: { type: "image", imageHash: "a", scaleMode: "FILL" }, stroke: { thickness: 1, fill: "$gone" } },
        { id: "grd", type: "rectangle", fill: [{ type: "gradient", gradientType: "linear", stops: [] }], cornerRadius: "$missing" },
      ],
    },
  ],
} as PenDocument;

describe("fig-only constructs never block", () => {
  const compiled = figCompile(FIG_ONLY);
  const raw = registry.flatMap((e) => e.run(compiled, DEFAULT_CONFIG));

  it("the raw rules do block on this document, so the downgrade is what is under test", () => {
    for (const rule of ["SCH-001", "SCH-002", "SCH-003"]) assert.ok(raw.some((v) => v.rule === rule && v.severity === "block"), rule);
  });

  for (const entry of registry) {
    it(`${entry.id}: violations on fig-marked nodes and image/gradient paints are review with a fixed severity`, () => {
      const out = run(compiled, [entry]);
      assert.ok(out.every((v) => v.severity !== "block"), JSON.stringify(out.filter((v) => v.severity === "block")));
      for (const v of out.filter((x) => raw.some((r) => r.rule === x.rule && r.severity === "block" && r.nodeId === x.nodeId))) {
        assert.equal(v.severity, "review");
        assert.equal(v.fixedSeverity, true);
      }
    });
  }

  it("a rule severity override cannot turn the review back into a block", () => {
    const config = { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "SCH-003": { ...DEFAULT_CONFIG.rules["SCH-003"], severity: "block" as const } } };
    const out = runRules([{ file: "a.fig", compiled }], config).filter((v) => v.rule === "SCH-003");
    assert.ok(out.length > 0);
    assert.ok(out.every((v) => v.severity === "review"));
  });

  it("a fake rule that blocks on a fig-marked node is downgraded to review, on a plain node it still blocks", () => {
    const fake: RuleEntry = {
      id: "SCH-001" as RuleId,
      title: "fake",
      description: "fake",
      defaultSeverity: "block",
      run: () =>
        ["grad", "img", "odd"].map((nodeId) => ({ rule: "SCH-001", severity: "block", file: "", nodeId, path: nodeId, message: "bad" })),
    };
    const out = run(compiled, [fake]);
    assert.deepEqual(out.map((v) => [v.nodeId, v.severity, v.fixedSeverity]), [
      ["grad", "review", true],
      ["img", "review", true],
      ["odd", "review", true],
    ]);
    const plain = figCompile({ version: "2.6", children: [{ id: "p", type: "frame", children: [] }] });
    assert.deepEqual(run(plain, [{ ...fake, run: () => [{ rule: "SCH-001", severity: "block", file: "", nodeId: "p", path: "p", message: "bad" }] }]).map((v) => v.severity), ["block"]);
  });

  it("a .pen document is never downgraded", () => {
    const pen = compile(FIG_ONLY, { file: "a.pen" });
    const out = runRules([{ file: "a.pen", compiled: pen }], DEFAULT_CONFIG, registry.filter((e) => e.id === "SCH-002"));
    assert.ok(out.some((v) => v.severity === "block"));
  });

  it("the image-fill fixture runs every rule without a block caused by the image", async () => {
    const source = await loadDesignSource("a.fig", fixtureBytes("image-fill", "head"));
    const out = run(figCompile(source.doc, source.figVersion));
    assert.ok(out.every((v) => v.severity !== "block"), JSON.stringify(out));
  });
});

describe("end to end on .fig repos", () => {
  async function check(base: string, head: string, since?: string): Promise<{ code: number; violations: Violation[] }> {
    const repo = await createFixtureRepo({ base, head });
    try {
      let out = "";
      const code = await runCheck(since ? { base: since } : {}, { cwd: repo.path, stdout: (t) => (out += t), stderr: (t) => (out += t), fs: defaultFs });
      return { code, violations: (JSON.parse(out) as { violations: Violation[] }).violations };
    } finally {
      await repo.cleanup();
    }
  }
  const tok = (file: string, nodeId: string, path: string) => ({
    rule: "TOK-001",
    severity: "block",
    file,
    nodeId,
    path,
    message: "Hard-coded fill value #0000ff; use a variable",
  });

  it("check on the .fig fixture repo runs every rule and reports the expected violations", async () => {
    for (const since of [undefined, "base"]) {
      const r = await check("check/fig-base", "check/fig-head", since);
      assert.equal(r.code, 1);
      assert.deepEqual(r.violations, [tok("card.fig", "1:102", "1:101/1:102")]);
    }
  });

  it("check on a mixed .pen + .fig repo loads each file with its own format", async () => {
    for (const since of [undefined, "base"]) {
      const r = await check("check/mixed-base", "check/mixed-head", since);
      assert.equal(r.code, 1);
      assert.deepEqual(r.violations, [tok("card.fig", "1:102", "1:101/1:102"), tok("ok.pen", "r", "f/r")]);
    }
  });

  it("diff on a mixed repo lists both files with their statuses and changes", async () => {
    const repo = await createFixtureRepo({ base: "check/mixed-base", head: "check/mixed-head" });
    try {
      const json = JSON.parse(serializeDiff(await computeSemanticDiff({ repo: repo.path, base: "base", head: "head" }))) as {
        files: { path: string; status: string; frames: { id: string; nodes: { id: string; kind?: string; status?: string }[] }[] }[];
      };
      assert.deepEqual(json.files.map((f) => [f.path, f.status]), [["card.fig", "modified"], ["ok.pen", "modified"]]);
      for (const f of json.files) assert.ok(f.frames.flatMap((fr) => fr.nodes).length > 0, f.path);
    } finally {
      await repo.cleanup();
    }
  });
});
