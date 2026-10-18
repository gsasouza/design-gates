import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNeeds, type ContractNeeds } from "../src/contract/needs.js";
import type { RuleId } from "../src/gates/config.js";

// Mutation checked: changing `if (out[input] !== "required") out[input] = need;` to `out[input] = need;`
// makes the second order fail (the later optional need overwrites the required one).

const table: Partial<Record<RuleId, ContractNeeds>> = {
  "TOK-001": { map: "optional" },
  "TOK-002": { map: "required" },
};

test("mergeNeeds: required wins over optional in either order", () => {
  assert.deepEqual(mergeNeeds(["TOK-001", "TOK-002"], table), { map: "required" });
  assert.deepEqual(mergeNeeds(["TOK-002", "TOK-001"], table), { map: "required" });
});
