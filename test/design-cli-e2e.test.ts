import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/design-cli.js", import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const git = async (cwd: string, ...args: string[]) => (await run("git", ["--no-optional-locks", ...args], { cwd, env })).stdout;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
const design = async (args: string[], cwd?: string): Promise<Result> => {
  try {
    const r = await run(process.execPath, [CLI, ...args], { ...(cwd && { cwd }), env, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
};

let fx: FixtureRepo;
let out: string;
before(async () => {
  fx = await createFixtureRepo({ base: "base", head: "head" });
  out = await mkdtemp(path.join(tmpdir(), "design-e2e-"));
});
after(async () => {
  await fx.cleanup();
  await rm(out, { recursive: true, force: true });
});

test("design --help lists every command and exits 0", async () => {
  const r = await design(["--help"]);
  assert.equal(r.code, 0);
  for (const c of ["init", "status", "save", "history", "compare", "restore", "explore", "switch"]) {
    assert.match(r.stdout, new RegExp(`\\b${c}\\b`));
  }
});

test("a designer's whole session works against a real repository", async () => {
  const repo = ["--repo", fx.path];
  const file = path.join(fx.path, "fill.pen");
  const original = await readFile(file, "utf8");

  const init = await design(["init", ...repo, "--json"]);
  assert.equal(init.code, 0);
  assert.equal(JSON.parse(init.stdout).createdRepo, false);
  const again = JSON.parse((await design(["init", ...repo, "--json"])).stdout);
  assert.equal(again.changed, false);

  await writeFile(file, original.replace("#00ff00", "#0000ff"));
  const status = await design(["status", ...repo]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /fill\.pen/);

  const saved = await design(["save", "-m", "Blue fill", ...repo]);
  assert.equal(saved.code, 0);
  assert.match(saved.stdout, /Blue fill/);
  assert.equal(JSON.parse((await design(["save", ...repo, "--json"])).stdout).saved, false);

  const history = await design(["history", ...repo]);
  assert.match(history.stdout, /^#1 .*Blue fill$/m);
  assert.match(history.stdout, /^#2 .*head$/m);

  const compare = await design(["compare", "#2", "#1", "--out", out, ...repo, "--json"]);
  assert.equal(compare.code, 0, compare.stderr);
  const result = JSON.parse(compare.stdout);
  assert.equal(result.files, 1);
  assert.ok(result.changes > 0);
  assert.ok(result.summary.length > 0);
  assert.ok(existsSync(path.join(out, "report.html")));
  const diff = JSON.parse(await readFile(path.join(out, "diff.json"), "utf8"));
  assert.deepEqual(diff.files.map((f: { path: string }) => f.path), ["fill.pen"]);

  const logBefore = await git(fx.path, "log", "--format=%H");
  const restore = await design(["restore", "#2", ...repo]);
  assert.equal(restore.code, 0, restore.stderr);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(await git(fx.path, "log", "--format=%H"), logBefore);

  assert.equal((await design(["save", "-m", "Back to green", ...repo])).code, 0);
  const explore = await design(["explore", "idea", ...repo]);
  assert.equal(explore.code, 0, explore.stderr);
  await writeFile(file, original.replace("#00ff00", "#ff00ff"));
  const refused = await design(["switch", "main", ...repo]);
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.length > 0);
  assert.equal(refused.stdout, "");
  assert.equal((await design(["save", "-m", "Magenta idea", ...repo])).code, 0);
  const back = await design(["switch", "main", ...repo]);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(await readFile(file, "utf8"), original);
});

test("an unknown version is a usage error with exit 2", async () => {
  const r = await design(["restore", "nope-nope", "--repo", fx.path]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nope-nope/);
});
