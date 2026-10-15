import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function check(rule: "TOK-001" | "TOK-002", name: string, raw?: unknown): Promise<Violation[]> {
  const compiled = await compileFixture(`${rule}/${name}.pen`);
  return runRules([{ file: `${rule}/${name}.pen`, compiled }], config(raw)).filter((v) => v.rule === rule);
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

test("TOK-001 unique candidate gives a replace fix, case-insensitive", async () => {
  const out = await check("TOK-001", "unique-candidate.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.prop, v.severity, v.fix]), [["box", "fill", "block", { type: "replace", prop: "fill", value: "$danger" }]]);
  assert.deepEqual(await check("TOK-001", "unique-candidate.pass"), []);
});

test("TOK-001 several candidates are sorted by name; #RGB and #RRGGBBAA normalise", async () => {
  const out = await check("TOK-001", "two-candidates.fail");
  assert.deepEqual(out[0]?.fix, { type: "candidates", prop: "fill", candidates: ["$a-red", "$b-red"] });
  assert.deepEqual(await check("TOK-001", "two-candidates.pass"), []);
});

test("TOK-001 without a matching variable has no fix", async () => {
  const out = await check("TOK-001", "ignore-values.fail");
  assert.equal(out.length, 3);
  assert.ok(out.every((v) => v.fix === undefined));
});

test("TOK-001 ignoreValues honours strings and regexes, per property", async () => {
  const cases: unknown[] = [
    { rules: { "TOK-001": { ignoreValues: { fill: ["transparent", "#123456"] } } } },
    { rules: { "TOK-001": { ignoreValues: { fill: ["transparent", "/^#1234/"] } } } },
    { rules: { "TOK-001": { ignoreValues: { fill: ["TRANSPARENT".toLowerCase(), "#123456"] } } } },
  ];
  for (const raw of cases) assert.deepEqual(summary(await check("TOK-001", "ignore-values.fail", raw)), ["c:fill:block"]);
  const all = { rules: { "TOK-001": { ignoreValues: { fill: ["transparent", "/^#[0-9a-fA-F]{6}$/"] } } } };
  assert.deepEqual(await check("TOK-001", "ignore-values.fail", all), []);
  assert.deepEqual(await check("TOK-001", "ignore-values.pass", { rules: { "TOK-001": { ignoreValues: { fill: ["transparent", "#123456"] } } } }), []);
  const wrongProp = { rules: { "TOK-001": { ignoreValues: { gap: ["transparent"] } } } };
  assert.equal((await check("TOK-001", "ignore-values.fail", wrongProp)).length, 3);
});

test("TOK-001 rejects bad ignoreValues regexes as config errors", () => {
  const bad = (v: unknown): unknown => resolveConfig({ rules: { "TOK-001": { ignoreValues: v } } });
  for (const v of [{ fill: ["/[/"] }, 5, [1]]) {
    assert.ok("error" in (bad(v) as object), JSON.stringify(v));
  }
  assert.ok("config" in (bad({ fill: ["/^#[0-9a-f]+$/"] }) as object));
  assert.ok("error" in (bad({ fill: ["/^(a+)+$/"] }) as object));
  assert.ok("error" in (resolveConfig({ rules: { "TOK-001": { properties: ["margin"] } } }) as object));
  assert.ok("config" in (resolveConfig({ rules: { "TOK-001": { properties: ["stroke", "gap"] } } }) as object));
});

test("TOK-001 reports a component literal once, on the component, with sorted affectedInstances", async () => {
  const out = await check("TOK-001", "inherited.fail");
  assert.deepEqual(summary(out), ["b3:fill:block", "b4::label:fill:block", "btn:fill:block", "label:fill:block"]);
  const comp = out.find((v) => v.nodeId === "btn");
  assert.deepEqual(comp?.affectedInstances, ["b1", "b2", "b3", "b4"]);
  assert.deepEqual(out.find((v) => v.nodeId === "label")?.affectedInstances, ["b1", "b2", "b3", "b4"]);
  assert.equal(out.find((v) => v.nodeId === "b4::label")?.affectedInstances, undefined);
  assert.equal(out.find((v) => v.nodeId === "b3")?.affectedInstances, undefined);
  assert.deepEqual(await check("TOK-001", "inherited.pass"), []);
});

test("TOK-001 onlyIn limits the scope by frame id or name", async () => {
  assert.deepEqual(summary(await check("TOK-001", "only-in.fail")), ["inA:fill:block", "inB:fill:block"]);
  assert.deepEqual(summary(await check("TOK-001", "only-in.fail", { rules: { "TOK-001": { onlyIn: ["A"] } } })), ["inA:fill:block"]);
  assert.deepEqual(summary(await check("TOK-001", "only-in.fail", { rules: { "TOK-001": { onlyIn: ["Be*"] } } })), ["inB:fill:block"]);
  assert.deepEqual(await check("TOK-001", "only-in.pass", { rules: { "TOK-001": { onlyIn: ["Alpha"] } } }), []);
});

test("TOK-001 severity is block for colours and fontSize, warn otherwise", async () => {
  const out = await check("TOK-001", "severity.fail");
  const bySev = Object.fromEntries(out.map((v) => [v.prop, v.severity]));
  assert.deepEqual(bySev, {
    cornerRadius: "warn",
    "effect.color": "block",
    fill: "block",
    fontFamily: "warn",
    fontSize: "block",
    gap: "warn",
    "stroke.fill": "block",
    "stroke.thickness": "warn",
  });
  const gapOnly = await check("TOK-001", "severity.fail", { rules: { "TOK-001": { properties: ["gap"] } } });
  assert.deepEqual(summary(gapOnly), ["box:gap:warn"]);
  assert.deepEqual(await check("TOK-001", "severity.pass"), []);
});

test("TOK-001 accepts string, object and list shapes and skips unknown ones", async () => {
  assert.deepEqual(
    summary(await check("TOK-001", "shapes.fail")),
    [
      "fillArr:fill[1].color:block",
      "fillObj:fill.color:block",
      "fillStr:fill:block",
      "fxArr:effect[0].color:block",
      "fxObj:effect.color:block",
      "pad:padding[0]:warn",
      "pad:padding[1]:warn",
      "radii:cornerRadius[0]:warn",
      "radii:cornerRadius[1]:warn",
      "radii:cornerRadius[2]:warn",
      "radii:cornerRadius[3]:warn",
      "strokeArr:stroke[0].fill:block",
      "strokeArr:stroke[1].fill:block",
      "strokeObj:stroke.fill:block",
      "strokeObj:stroke.thickness.left:warn",
      "strokeObj:stroke.thickness.top:warn",
      "strokeStr:stroke:block",
    ],
  );
  assert.deepEqual(await check("TOK-001", "shapes.pass"), []);
});

test("TOK-002 gap 18 on base 4 suggests 16 and 20", async () => {
  const out = await check("TOK-002", "gap-18.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.prop, v.severity, v.fix]), [
    ["box", "gap", "warn", { type: "candidates", prop: "gap", candidates: [16, 20] }],
    ["box", "padding[1]", "warn", { type: "candidates", prop: "padding[1]", candidates: [16, 20] }],
  ]);
  assert.deepEqual(await check("TOK-002", "gap-18.pass"), []);
});

test("TOK-002 reports an off-scale variable definition once, not per use", async () => {
  const out = await check("TOK-002", "variable-definition.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.path, v.prop]), [["$space", "variables/space", "value.spacing"]]);
  assert.match(out[0]?.message ?? "", /spacing/);
  assert.deepEqual(await check("TOK-002", "variable-definition.pass"), []);
});

test("TOK-002 checks values resolved through a variable chain on the defining variable", async () => {
  const out = await check("TOK-002", "resolved-through-variable.fail");
  assert.deepEqual(out.map((v) => `${v.nodeId}:${v.message}`), [
    "$odd:Variable $odd = 3 is off the radius scale; nearest: 2, 4",
    "$odd:Variable $odd = 3 is off the strokeWidth scale; nearest: 2, 4",
    "$space:Variable $space = 18 is off the spacing scale; nearest: 16, 20",
  ]);
  assert.deepEqual(await check("TOK-002", "resolved-through-variable.pass"), []);
});

test("TOK-002 checks each theme's value of a variable", async () => {
  const out = await check("TOK-002", "themed-variable.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.theme]), [["$space", "density=compact"]]);
});

test("TOK-002 strict escalates to block and ignores severity overrides", async () => {
  assert.deepEqual(summary(await check("TOK-002", "strict.fail")), ["box:gap:warn"]);
  const strict = await check("TOK-002", "strict.fail", { strict: true, rules: { "TOK-002": { severity: "warn" } } });
  assert.deepEqual(summary(strict), ["box:gap:block"]);
  assert.deepEqual(await check("TOK-002", "strict.pass", { strict: true }), []);
});

test("TOK-002 list scales, equidistant ties, nearest only, base scales and tolerance", async () => {
  const fail = await check("TOK-002", "scale-list.fail");
  assert.deepEqual(fail.map((v) => [v.nodeId, v.prop, (v.fix as { candidates: number[] }).candidates]), [
    ["t", "fontSize", [14, 16]],
    ["t", "stroke.thickness", [2, 4]],
    ["u", "fontSize", [16, 20]],
  ]);
  assert.deepEqual(await check("TOK-002", "scale-list.pass"), []);
  const tolerant = await check("TOK-002", "scale-list.fail", { rules: { "TOK-002": { tolerance: 1 } } });
  assert.deepEqual(tolerant.map((v) => v.nodeId + ":" + v.prop), ["u:fontSize"]);
  const custom = { rules: { "TOK-002": { scales: { fontSize: [10, 30], radius: { base: 2 }, spacing: { base: 5 }, strokeWidth: [2, 4] } } } };
  const nearest = await check("TOK-002", "scale-list.fail", custom);
  assert.deepEqual(nearest.map((v) => (v.fix as { candidates: number[] }).candidates), [[10], [2, 4], [10]]);
});

test("TOK-002 reports a component's value once with affectedInstances", async () => {
  const out = await check("TOK-002", "inherited.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.affectedInstances]), [["b1", undefined], ["btn", ["b1", "b2"]]]);
  assert.deepEqual(await check("TOK-002", "inherited.pass"), []);
});

test("TOK-002 rejects bad scales", () => {
  for (const scales of [{ spacing: { base: 0 } }, { spacing: { base: 4, x: 1 } }, { spacing: "4" }]) {
    assert.ok("error" in (resolveConfig({ rules: { "TOK-002": { scales } } }) as object), JSON.stringify(scales));
  }
});

test("TOK-001 and TOK-002 are deterministic", async () => {
  for (const [rule, name] of [["TOK-001", "shapes.fail"], ["TOK-001", "inherited.fail"], ["TOK-002", "resolved-through-variable.fail"], ["TOK-002", "gap-18.fail"]] as const) {
    const a = JSON.stringify(await check(rule, name));
    const b = JSON.stringify(await check(rule, name));
    assert.equal(a, b);
    assert.ok(a.length > 2);
  }
});
