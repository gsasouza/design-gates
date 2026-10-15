import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAlias } from "../src/index.js";
import { bakeVariables } from "../src/render/themes.js";
import type { PenVariables } from "../src/index.js";

const variables: PenVariables = {
  brand: { type: "color", value: "$primary" },
  primary: {
    type: "color",
    value: [
      { value: "#111111", theme: { mode: "light" } },
      { value: "#EEEEEE", theme: { mode: "dark" } },
    ],
  },
  plain: { type: "color", value: "#123456" },
  a: { type: "color", value: "$b" },
  b: { type: "color", value: "$a" },
  self: { type: "color", value: "$self" },
  dangling: { type: "color", value: "$missing" },
  darkOnly: { type: "color", value: [{ value: "#000000", theme: { mode: "dark" } }] },
};

test("resolveAlias returns the concrete value and the chain", () => {
  assert.deepEqual(resolveAlias("$plain", variables, {}), { value: "#123456", chain: ["plain"], status: "ok" });
  assert.deepEqual(resolveAlias("$brand", variables, { mode: "light" }), { value: "#111111", chain: ["brand", "primary"], status: "ok" });
});

test("resolveAlias resolves per theme", () => {
  assert.equal(resolveAlias("$brand", variables, { mode: "dark" }).value, "#EEEEEE");
  assert.equal(resolveAlias("$brand", variables, { mode: "light" }).value, "#111111");
});

test("resolveAlias reports undefined and no-value separately", () => {
  assert.deepEqual(resolveAlias("$nope", variables, {}), { value: "$nope", chain: ["nope"], status: "undefined" });
  assert.deepEqual(resolveAlias("$dangling", variables, {}), { value: "$missing", chain: ["dangling", "missing"], status: "undefined" });
  assert.deepEqual(resolveAlias("$darkOnly", variables, { mode: "light" }), { value: "$darkOnly", chain: ["darkOnly"], status: "no-value" });
  assert.equal(resolveAlias("$constructor", variables, {}).status, "undefined");
});

test("resolveAlias reports cycles without throwing", () => {
  assert.deepEqual(resolveAlias("$a", variables, {}), { value: "$a", chain: ["a", "b", "a"], status: "cycle" });
  assert.deepEqual(resolveAlias("$self", variables, {}), { value: "$self", chain: ["self", "self"], status: "cycle" });
});

test("resolveAlias bounds very long chains", () => {
  const long: PenVariables = {};
  for (let i = 0; i < 1000; i++) long[`v${i}`] = { type: "color", value: `$v${i + 1}` };
  assert.equal(resolveAlias("$v0", long, {}).status, "too-deep");
});

test("the renderer wrapper keeps its behaviour", () => {
  assert.deepEqual(bakeVariables({ fill: "$brand" }, variables, { mode: "dark" }), { fill: "#EEEEEE" });
  assert.deepEqual(bakeVariables({ fill: "$nope" }, variables, {}), { fill: "$nope" });
  assert.deepEqual(bakeVariables({ fill: "$dangling" }, variables, {}), { fill: "$missing" });
  assert.throws(() => bakeVariables({ fill: "$a" }, variables, {}), { message: "Variable alias cycle: $a -> $b -> $a" });
});
