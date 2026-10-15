import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTROLLED_PROPS } from "../src/gates/tok.js";
import { DEFAULT_CONFIG, resolveConfig, RULE_IDS } from "../src/index.js";

test("defaults", () => {
  const r = resolveConfig(undefined);
  assert.deepEqual(r, { config: DEFAULT_CONFIG });
  assert.ok("config" in r && r.config !== DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig({}), { config: DEFAULT_CONFIG });
  assert.equal(DEFAULT_CONFIG.canvasColor, "#FFFFFF");
  assert.equal(DEFAULT_CONFIG.strict, false);
  assert.deepEqual(DEFAULT_CONFIG.rules["A11Y-001"], { minRatio: 4.5, minRatioLarge: 3 });
  assert.deepEqual(DEFAULT_CONFIG.rules["CMP-001"], { minNodes: 3 });
  assert.deepEqual(DEFAULT_CONFIG.rules["DIF-001"], { warnAt: 5, blockAt: 20, scope: ["*"] });
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.rules), [...RULE_IDS]);
});

test("overrides merge over the defaults", () => {
  const r = resolveConfig({
    canvasColor: "#101010",
    strict: true,
    rules: { "A11Y-001": { minRatio: 7, severity: "warn" }, "SCH-001": { severity: "off" }, "TOK-001": { ignoreValues: ["transparent"], extra: 1 } },
  });
  assert.ok("config" in r);
  assert.equal(r.config.canvasColor, "#101010");
  assert.equal(r.config.strict, true);
  assert.deepEqual(r.config.rules["A11Y-001"], { minRatio: 7, minRatioLarge: 3, severity: "warn" });
  assert.equal(r.config.rules["SCH-001"].severity, "off");
  assert.deepEqual(r.config.rules["TOK-001"].ignoreValues, ["transparent"]);
  assert.deepEqual(r.config.rules["TOK-001"].properties, [...CONTROLLED_PROPS]);
  assert.equal(r.config.rules["TOK-001"].extra, 1);
  assert.equal(DEFAULT_CONFIG.strict, false);
});

test("invalid shapes are errors, never throws", () => {
  const bad: [unknown, RegExp][] = [
    [[], /object/],
    [{ nope: 1 }, /unknown config key "nope"/],
    [{ canvasColor: "white" }, /canvasColor/],
    [{ strict: "yes" }, /strict/],
    [{ rules: [] }, /rules must be an object/],
    [{ rules: { "XXX-001": {} } }, /unknown rule "XXX-001"/],
    [{ rules: { "SCH-001": "off" } }, /rules.SCH-001 must be an object/],
    [{ rules: { "SCH-001": { severity: "loud" } } }, /rules.SCH-001.severity/],
    [{ rules: { "A11Y-001": { minRatio: "4.5" } } }, /minRatio/],
    [{ rules: { "CMP-001": { minNodes: 1.5 } } }, /minNodes/],
    [{ rules: { "DIF-001": { warnAt: 30 } } }, /warnAt must not exceed blockAt/],
    [{ rules: { "TOK-001": { properties: "fill" } } }, /properties/],
    [{ rules: { "TOK-002": { scales: { spacing: ["a"] } } } }, /scales/],
  ];
  for (const [raw, re] of bad) {
    const r = resolveConfig(raw);
    assert.ok("error" in r, JSON.stringify(raw));
    assert.match(r.error, re);
  }
});
