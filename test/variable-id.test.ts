import assert from "node:assert/strict";
import { test } from "node:test";
import { isVariableNodeId, variableNodeId } from "../src/gates/variable-id.js";

test("variableNodeId round trips through isVariableNodeId", () => {
  assert.equal(variableNodeId("gray-900"), "$var:gray-900");
  assert.equal(isVariableNodeId(variableNodeId("gray-900")), true);
});

test("a normal node id is not a variable id", () => {
  assert.equal(isVariableNodeId("abc123"), false);
  assert.equal(isVariableNodeId(""), false);
});
