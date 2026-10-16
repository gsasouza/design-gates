import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, DEFAULT_CONFIG, diffVariables, parsePen, registry, resolveConfig, type CompiledDocument, type GatesConfig, type Violation } from "../src/index.js";
import { defaultFs } from "../src/cli/run-diff.js";
import { runCheck } from "../src/cli/run-check.js";
import { compileFixture, gateFixture } from "./helpers/gates.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const rule = (id: string) => registry.find((r) => r.id === id)!;

async function cmp(name: string, config: GatesConfig = DEFAULT_CONFIG): Promise<Violation[]> {
  return rule("CMP-001").run(await compileFixture(`CMP-001/${name}.pen`), config);
}

async function load(name: string): Promise<{ doc: ReturnType<typeof parsePen>; compiled: CompiledDocument }> {
  const doc = parsePen(await readFile(gateFixture(name), "utf8"));
  return { doc, compiled: compile(doc, { file: name }) };
}

async function dif(name: string, overrides: Record<string, unknown> = {}): Promise<Violation[]> {
  const base = await load(`DIF-001/${name}.base.pen`);
  const head = await load(`DIF-001/${name}.head.pen`);
  const resolved = resolveConfig({ rules: { "DIF-001": overrides } });
  assert.ok("config" in resolved);
  return rule("DIF-001").run(head.compiled, resolved.config, {
    base: base.compiled,
    head: head.compiled,
    variables: diffVariables({ [name]: { base: base.doc, head: head.doc } }),
  });
}

test("CMP-001: a copy of button with different text carries the new content in a ref fix", async () => {
  const v = await cmp("text-copy.fail");
  assert.deepEqual(v, [
    {
      rule: "CMP-001",
      severity: "warn",
      file: "CMP-001/text-copy.fail.pen",
      nodeId: "save2",
      path: "screen/save2",
      message: 'Subtree duplicates component "button"; use an instance instead',
      fix: { type: "ref", ref: "button", descendants: { label: { content: "Cancel" } } },
    },
  ]);
  assert.deepEqual(await cmp("text-copy.pass"), []);
});

test("CMP-001: same shape with different styling is not reported", async () => {
  assert.deepEqual(await cmp("styled-copy.pass"), []);
  assert.equal((await cmp("styled-copy.fail")).length, 1);
});

test("CMP-001: a subtree under minNodes is ignored", async () => {
  assert.deepEqual(await cmp("min-nodes.pass"), []);
  const strict = resolveConfig({ rules: { "CMP-001": { minNodes: 2 } } });
  assert.ok("config" in strict);
  assert.equal((await cmp("min-nodes.pass", strict.config)).length, 1);
  assert.equal((await cmp("min-nodes.fail")).length, 1);
});

test("CMP-001: a real ref instance is not reported", async () => {
  assert.deepEqual(await cmp("ref-instance.pass"), []);
  assert.equal((await cmp("ref-instance.fail")).length, 1);
});

test("CMP-001: only the outermost match is reported", async () => {
  const v = await cmp("outermost.fail");
  assert.equal(v.length, 1);
  assert.equal(v[0]!.nodeId, "c2");
  assert.deepEqual(v[0]!.fix, { type: "ref", ref: "card", descendants: { heading: { content: "Other" } } });
  assert.deepEqual(await cmp("outermost.pass"), []);
});

test("CMP-001: several matching components pick the smallest id and list the others", async () => {
  const { doc } = await load("CMP-001/text-copy.fail.pen");
  const button = doc.children.find((c) => c.id === "button")!;
  const twin = parsePen(JSON.stringify({ ...doc, children: [{ ...button, id: "a-button" }, ...doc.children] }));
  const v = rule("CMP-001").run(compile(twin, { file: "twin.pen" }), DEFAULT_CONFIG);
  assert.equal(v.length, 1);
  assert.equal((v[0]!.fix as { ref: string }).ref, "a-button");
  assert.match(v[0]!.message, /also matches "button"/);
});

test("DIF-001: a component change lists the screens of its instances", async () => {
  const v = await dif("component-screens.fail", { warnAt: 1 });
  assert.equal(v.length, 1);
  assert.deepEqual(v[0], {
    rule: "DIF-001",
    severity: "warn",
    file: "DIF-001/component-screens.fail.head.pen",
    nodeId: "button",
    path: "button",
    message: 'Component "button" changed: 3 instances in 2 screens (s1, s2)',
    affectedInstances: ["a1", "a2", "b1"],
  });
  assert.deepEqual(await dif("component-screens.pass", { warnAt: 0 }), []);
});

test("DIF-001: thresholds, block and scope", async () => {
  assert.deepEqual(await dif("component-screens.fail", { warnAt: 4, blockAt: 10 }), []);
  assert.equal((await dif("component-screens.fail", { warnAt: 1, blockAt: 3 }))[0]!.severity, "block");
  assert.equal((await dif("component-screens.fail", { warnAt: 1, blockAt: 3, scope: ["button"] }))[0]!.severity, "warn");
  assert.equal((await dif("component-screens.fail", { warnAt: 1, blockAt: 3, scope: ["Bu*"] }))[0]!.severity, "warn");
  assert.equal((await dif("component-screens.fail", { warnAt: 1, blockAt: 3, scope: ["other"] }))[0]!.severity, "block");
});

test("DIF-001: a variable change counts nodes per theme", async () => {
  const v = await dif("variable-themes.fail", { warnAt: 1 });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.nodeId, "$bg");
  assert.equal(v[0]!.severity, "warn");
  assert.equal(v[0]!.message, "Variable $bg changed: mode=dark: 2 nodes; 2 nodes in 1 screens (p2)");
  assert.equal((await dif("variable-themes.fail", { warnAt: 1, blockAt: 2 }))[0]!.severity, "block");
  assert.equal((await dif("variable-themes.fail", { warnAt: 1, blockAt: 2, scope: ["$bg"] }))[0]!.severity, "warn");
  assert.deepEqual(await dif("variable-themes.fail", { warnAt: 3 }), []);
  assert.deepEqual(await dif("variable-themes.pass", { warnAt: 0 }), []);
});

test("DIF-001: no diff context means no violations", async () => {
  assert.deepEqual(rule("DIF-001").run(await compileFixture("DIF-001/component-screens.fail.head.pen"), DEFAULT_CONFIG), []);
});

test("CMP-001 and DIF-001 are deterministic", async () => {
  const a = JSON.stringify([await cmp("outermost.fail"), await dif("component-screens.fail"), await dif("variable-themes.fail", { warnAt: 1 })]);
  const b = JSON.stringify([await cmp("outermost.fail"), await dif("component-screens.fail"), await dif("variable-themes.fail", { warnAt: 1 })]);
  assert.equal(a, b);
});

test("check --base exits 1 when a component change reaches blockAt", async () => {
  const repo = await createFixtureRepo({ base: "gates/DIF-001/cli/base", head: "gates/DIF-001/cli/head" });
  try {
    let out = "";
    const code = await runCheck({ base: "base" }, { cwd: repo.path, stdout: (t) => (out += t), stderr: () => undefined, fs: defaultFs });
    assert.equal(code, 1);
    const violations = (JSON.parse(out) as { violations: Violation[] }).violations;
    assert.deepEqual(violations.map((x) => [x.rule, x.severity, x.nodeId]), [["DIF-001", "block", "button"]]);
  } finally {
    await repo.cleanup();
  }
});

test("DIF-001: a theme axis change is reported with the nodes pinning it", async () => {
  const mk = (themes: Record<string, string[]>) =>
    parsePen(JSON.stringify({ version: "2.6", themes, children: [{ id: "s", type: "frame", children: [{ id: "p", type: "frame", theme: { mode: "dark" } }] }] }));
  const baseDoc = mk({});
  const headDoc = mk({ mode: ["light", "dark"] });
  const resolved = resolveConfig({ rules: { "DIF-001": { warnAt: 1 } } });
  assert.ok("config" in resolved);
  const head = compile(headDoc, { file: "t.pen" });
  const v = rule("DIF-001").run(head, resolved.config, {
    base: compile(baseDoc, { file: "t.pen" }),
    head,
    variables: diffVariables({ "t.pen": { base: baseDoc, head: headDoc } }),
  });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.nodeId, "theme:mode");
  assert.equal(v[0]!.message, "Theme mode added: mode=dark: 1 nodes; 1 nodes in 1 screens (s)");
});

function difInline(baseDoc: unknown, headDoc: unknown, warnAt = 1): Violation[] {
  const b = parsePen(JSON.stringify(baseDoc));
  const h = parsePen(JSON.stringify(headDoc));
  const resolved = resolveConfig({ rules: { "DIF-001": { warnAt } } });
  assert.ok("config" in resolved);
  const head = compile(h, { file: "t.pen" });
  return rule("DIF-001").run(head, resolved.config, {
    base: compile(b, { file: "t.pen" }),
    head,
    variables: diffVariables({ "t.pen": { base: b, head: h } }),
  });
}

const nested = (labelFill: string) => ({
  version: "2.6",
  children: [
    { id: "B", type: "frame", reusable: true, children: [{ id: "lbl", type: "text", content: "x", fill: labelFill }] },
    { id: "A", type: "frame", reusable: true, children: [{ id: "inner", type: "ref", ref: "B" }] },
    { id: "s", type: "frame", children: [{ id: "useA", type: "ref", ref: "A" }, { id: "useB", type: "ref", ref: "B" }] },
  ],
});

test("DIF-001: a change inside nested B is reported once, on B, counting transitive instances", () => {
  const v = difInline(nested("#000000"), nested("#111111"));
  assert.deepEqual(v.map((x) => x.nodeId), ["B"]);
  // B is used directly by useB and, through A, by useA; the in-definition instance inner does not count
  assert.deepEqual(v[0]!.affectedInstances, ["useA", "useB"]);
});

test("DIF-001: reusable top-level frames are not counted as screens", () => {
  const v = difInline(nested("#000000"), nested("#111111"));
  assert.match(v[0]!.message, /in 1 screens \(s\)$/);
});
