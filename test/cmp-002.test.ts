import { test } from "node:test";
import assert from "node:assert/strict";
import { cmp002 } from "../src/rules/CMP-002.js";
import { compile, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "CMP-002": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};
const configError = (raw: unknown): string => {
  const r = resolveConfig(raw);
  assert.ok("error" in r);
  return r.error;
};

async function run(name: string, raw: unknown = ON, rule = "CMP-002"): Promise<Violation[]> {
  const file = `CMP-002/${name}.pen`;
  return runRules([{ file, compiled: await compileFixture(file) }], config(raw)).filter((v) => v.rule === rule);
}
const props = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}`);

test("allowed keys give no finding", async () => {
  assert.deepEqual(await run("allowed.pass"), []);
});

test("a disallowed $variable key is reported with the allowlist in the message", async () => {
  const out = await run("var-key.fail");
  assert.deepEqual(props(out), ["a:descendants.label.fill", "a:descendants.label.opacity"]);
  assert.equal(out[0]?.message, 'override of "fill" on descendants path "label" is not allowed by component "Button" (allowed: content, enabled, icon)');
  assert.equal(out[0]?.severity, "warn");
  assert.equal(out[0]?.path, "screen/a");
});

test("a literal controlled override is left to TOK-001", async () => {
  assert.deepEqual(await run("literal-fill.pass"), []);
  const tok = await run("literal-fill.pass", ON, "TOK-001");
  assert.ok(tok.some((v) => v.nodeId === "a::label" && v.prop === "fill"), JSON.stringify(tok));
});

test("mixed and non-solid controlled values are still reported", async () => {
  assert.deepEqual(props(await run("mixed.fail")), ["a:descendants.label.fill", "a:descendants.label.stroke"]);
});

test("type replacement is allowed inside a slot and reported outside", async () => {
  assert.deepEqual(await run("type-slot.pass"), []);
  const out = await run("type-nonslot.fail");
  assert.deepEqual(props(out), ["a:descendants.box.type", "a:descendants.box/leaf.type"]);
});

test("children replacement is allowed on a slot and reported on a non-slot frame", async () => {
  assert.deepEqual(await run("children-slot.pass"), []);
  assert.deepEqual(props(await run("children-nonslot.fail")), ["a:descendants.box.children"]);
});

test("a glob-specific allowlist wins over * (first match in insertion order)", async () => {
  assert.deepEqual(props(await run("glob.fail")), ["a:descendants.label.opacity"]);
  const specific = { rules: { "CMP-002": { allowedOverrides: { "Butt*": ["opacity"], "*": ["content"] } } } };
  assert.deepEqual(props(await run("glob.fail", specific)), ["a:descendants.label.content"]);
  const byName = { rules: { "CMP-002": { allowedOverrides: { "*": ["content"], "Butt*": ["opacity"] } } } };
  assert.deepEqual(props(await run("glob.fail", byName)), ["a:descendants.label.opacity"]);
  const byId = { rules: { "CMP-002": { allowedOverrides: { btn: ["opacity", "content"] } } } };
  assert.deepEqual(await run("glob.fail", byId), []);
  const none = { rules: { "CMP-002": { allowedOverrides: { Other: ["opacity"] } } } };
  const out = await run("glob.fail", none);
  assert.equal(out.length, 2);
  assert.match(out[0]!.message, /\(allowed: none\)$/);
});

test("the rule is silent when not enabled", async () => {
  assert.deepEqual(await run("var-key.fail", {}), []);
  assert.deepEqual(await run("var-key.fail", { rules: { "CMP-001": {} } }), []);
});

test("output is sorted and (nodeId, prop) pairs are unique", async () => {
  for (const name of ["type-nonslot.fail", "var-key.fail", "mixed.fail", "glob.fail"]) {
    const out = await run(name);
    const keys = out.map((v) => `${v.nodeId}\0${v.prop}`);
    assert.ok(keys.length > 0);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(new Set(keys).size, keys.length);
  }
});

test("a nested instance in a definition is reported once, not on each expanded copy", () => {
  const doc = {
    version: "2.6",
    children: [
      { id: "inner", type: "frame", name: "Inner", reusable: true, children: [{ id: "t", type: "text", content: "x" }] },
      { id: "outer", type: "frame", name: "Outer", reusable: true, children: [{ id: "n", type: "ref", ref: "inner", descendants: { t: { opacity: 0.5 } } }] },
      { id: "u1", type: "ref", ref: "outer" },
      { id: "u2", type: "ref", ref: "outer" },
    ],
  };
  const out = runRules([{ file: "x.pen", compiled: compile(doc as never, { file: "x.pen" }) }], config(ON)).filter((v) => v.rule === "CMP-002");
  assert.deepEqual(props(out), ["n:descendants.t.opacity"]);
  const compiled = compile(doc as never, { file: "x.pen" });
  assert.deepEqual(compiled.nodes.filter((n) => n.overrides !== undefined).map((n) => n.id), ["n"]);
});

test("findings are sorted by prop whatever the order the overrides were written in", () => {
  const doc = {
    version: "2.6",
    children: [
      { id: "c", type: "frame", name: "C", reusable: true, children: [{ id: "t", type: "text", content: "x" }, { id: "b", type: "text", content: "y" }] },
      { id: "z", type: "ref", ref: "c", descendants: { t: { opacity: 1, gap: "$g" }, b: { opacity: 1 } } },
    ],
  };
  const out = cmp002(compile(doc as never, { file: "x.pen" }), config(ON));
  assert.deepEqual(props(out), ["z:descendants.b.opacity", "z:descendants.t.gap", "z:descendants.t.opacity"]);
});

test("allowedOverrides is validated", () => {
  const msg = /^rules\.CMP-002\.allowedOverrides must be an object mapping/;
  assert.match(configError({ rules: { "CMP-002": { allowedOverrides: [] } } }), msg);
  assert.match(configError({ rules: { "CMP-002": { allowedOverrides: { "*": "content" } } } }), msg);
  assert.match(configError({ rules: { "CMP-002": { allowedOverrides: { "*": [""] } } } }), msg);
  assert.match(configError({ rules: { "CMP-002": { allowedOverrides: { "*": [1] } } } }), msg);
  assert.deepEqual(config(ON).rules["CMP-002"].allowedOverrides, { "*": ["content", "enabled", "icon"] });
});

test("compile keeps raw overrides, including type and children, on non-expanded instance roots only", async () => {
  const compiled = await compileFixture("CMP-002/type-nonslot.fail.pen");
  const a = compiled.nodes.find((n) => n.id === "a");
  assert.deepEqual(a?.overrides, { box: { type: "ellipse" }, "box/leaf": { type: "ellipse" } });
  assert.equal(compiled.nodes.filter((n) => n.overrides !== undefined).length, 1);
});
