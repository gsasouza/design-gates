import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadPenFile } from "../src/index.js";
import { loadExpected } from "./helpers/expected.js";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";
import { fixtureUrl } from "./helpers/fixtures.js";

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run("git", ["--no-optional-locks", ...args], { cwd, env: gitEnv })).stdout.trim();

const repos: FixtureRepo[] = [];
after(async () => {
  await Promise.all(repos.map((r) => r.cleanup()));
});

const fixturePath = (side: string, file: string): string =>
  fileURLToPath(fixtureUrl(`${side}/${file}`));

test("every file named in expected.json exists in the right fixture dir", () => {
  const expected = loadExpected();
  assert.ok(expected.length > 0);
  for (const e of expected) {
    if (e.fileStatus !== "removed") {
      assert.ok(existsSync(fixturePath("head", e.file)), `head/${e.file}`);
    }
    if (e.fileStatus !== "added") {
      const baseFile = e.oldPath ?? e.file;
      assert.ok(existsSync(fixturePath("base", baseFile)), `base/${baseFile}`);
    }
    if (e.fileStatus === "added") assert.ok(!existsSync(fixturePath("base", e.file)), e.file);
    if (e.fileStatus === "removed") assert.ok(!existsSync(fixturePath("head", e.file)), e.file);
  }
});

test("fixture documents parse and contain the expected frames", async () => {
  for (const e of loadExpected()) {
    if (e.fileStatus === "removed") continue;
    const doc = await loadPenFile(fixturePath("head", e.file));
    assert.ok(doc.children.some((c) => JSON.stringify(c).includes(`"id":"${e.frameId}"`)), `${e.file}:${e.frameId}`);
  }
});

test("fixture repo has base and head commits with stable shas", async () => {
  const a = await createFixtureRepo();
  repos.push(a);
  const b = await createFixtureRepo();
  repos.push(b);
  assert.notEqual(a.path, b.path);

  assert.equal(await git(a.path, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal((await git(a.path, "rev-list", "--count", "main")).trim(), "2");
  const base = await git(a.path, "rev-parse", "base^{commit}");
  const head = await git(a.path, "rev-parse", "head^{commit}");
  assert.notEqual(base, head);
  assert.equal(await git(a.path, "rev-parse", "main"), head);
  assert.equal(await git(a.path, "rev-parse", "head^"), base);
  assert.equal(await git(b.path, "rev-parse", "base^{commit}"), base);
  assert.equal(await git(b.path, "rev-parse", "head^{commit}"), head);

  const status = await git(a.path, "diff", "--name-status", "-M", "-z", "base", "head", "--", ":(glob)**/*.pen");
  const entries = status.split("\0");
  assert.ok(entries.includes("R100"));
  assert.ok(entries.includes("old/renamed.pen") && entries.includes("new/renamed.pen"));
  assert.ok(entries.includes("A") && entries.includes("added.pen"));
  assert.ok(entries.includes("D") && entries.includes("removed.pen"));
  assert.ok(!entries.includes("unchanged.pen"));
});

test("cleanup removes the temp dir", async () => {
  const repo = await createFixtureRepo();
  assert.ok(existsSync(path.join(repo.path, ".git")));
  await repo.cleanup();
  assert.ok(!existsSync(repo.path));
});
