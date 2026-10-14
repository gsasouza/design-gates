import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("cli --help prints usage and exits 0", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: design-gates/);
});
