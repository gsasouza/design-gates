import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run("git", ["--no-optional-locks", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();

test("createFixtureRepo takes optional base and head fixture dirs", async () => {
  const repo = await createFixtureRepo({ base: "spike", head: "gates/compile" });
  try {
    assert.deepEqual((await git(repo.path, "ls-tree", "-r", "--name-only", "base")).split("\n"), ["simple.pen", "themed.pen"]);
    assert.ok((await git(repo.path, "ls-tree", "-r", "--name-only", "head")).split("\n").includes("instances.pen"));
  } finally {
    await repo.cleanup();
  }
});
