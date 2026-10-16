import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const design = async (args: string[]): Promise<Result> => {
  try {
    const r = await run(process.execPath, [CLI, ...args], { env, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
};

const FIG = fileURLToPath(new URL("../../fixtures/fig/text-change/", import.meta.url));
let fx: FixtureRepo;
let out: string;
before(async () => {
  // The trees only need to differ so both commits exist; the tests put the text-change files over base.fig.
  fx = await createFixtureRepo({ base: "fig/text-change", head: "fig/solid-fill" });
  out = await mkdtemp(path.join(tmpdir(), "design-fig-"));
});
after(async () => {
  await fx.cleanup();
  await rm(out, { recursive: true, force: true });
});

test("a .fig is saved, compared and restored byte-identical like a .pen", async () => {
  const repo = ["--repo", fx.path];
  const file = path.join(fx.path, "base.fig");
  await copyFile(path.join(FIG, "base.fig"), file);
  const original = await readFile(file);
  assert.equal((await design(["save", "-m", "Text before", ...repo])).code, 0);

  const clean = await design(["status", ...repo, "--json"]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).clean, true);

  await copyFile(path.join(FIG, "head.fig"), file);
  const status = JSON.parse((await design(["status", ...repo, "--json"])).stdout);
  assert.equal(status.clean, false);
  assert.deepEqual(status.files, [{ path: "base.fig", state: "changed" }]);

  const saved = await design(["save", "-m", "Text change", ...repo]);
  assert.equal(saved.code, 0, saved.stderr);
  assert.deepEqual(await readFile(file), await readFile(path.join(FIG, "head.fig")));
  assert.equal(JSON.parse((await design(["status", ...repo, "--json"])).stdout).clean, true);

  const compare = await design(["compare", "#2", "#1", "--out", out, ...repo, "--json"]);
  assert.equal(compare.code, 0, compare.stderr);
  const result = JSON.parse(compare.stdout);
  assert.equal(result.files, 1);
  assert.ok(result.changes > 0);
  const diff = JSON.parse(await readFile(path.join(out, "diff.json"), "utf8"));
  assert.deepEqual(diff.files.map((f: { path: string }) => f.path), ["base.fig"]);
  assert.equal(diff.files[0].frames.length, 1);

  const restore = await design(["restore", "#2", ...repo]);
  assert.equal(restore.code, 0, restore.stderr);
  assert.deepEqual(await readFile(file), original);
  assert.equal((await git(fx.path, "status", "--porcelain")).trim(), "M base.fig");
  assert.equal(JSON.parse((await design(["status", ...repo, "--json"])).stdout).clean, false);
});

test("a mixed .pen and .fig folder is handled together, and a pen<->fig rename is add plus delete", async () => {
  const repo = ["--repo", fx.path];
  await design(["save", "-m", "Settle", ...repo]);
  await writeFile(path.join(fx.path, "extra.pen"), '{"version":"2.6","children":[]}');
  const mixed = JSON.parse((await design(["status", ...repo, "--json"])).stdout);
  assert.deepEqual(mixed.files.map((f: { path: string }) => f.path), ["extra.pen"]);
  assert.equal((await design(["save", "-m", "Add pen", ...repo])).code, 0);

  await rename(path.join(fx.path, "extra.pen"), path.join(fx.path, "extra.fig"));
  const renamed = JSON.parse((await design(["status", ...repo, "--json"])).stdout);
  const byPath = Object.fromEntries(renamed.files.map((f: { path: string; state: string }) => [f.path, f]));
  assert.equal(byPath["extra.fig"].state, "new");
  assert.equal(byPath["extra.fig"].oldPath, undefined);
  assert.equal(byPath["extra.pen"].state, "deleted");
});

test("a staged pen->fig git mv is add plus delete, not a rename", async () => {
  const repo = ["--repo", fx.path];
  await writeFile(path.join(fx.path, "moved.pen"), '{"version":"2.6","children":[]}');
  assert.equal((await design(["save", "-m", "Add moved", ...repo])).code, 0);
  await git(fx.path, "mv", "moved.pen", "moved.fig");
  const status = JSON.parse((await design(["status", ...repo, "--json"])).stdout);
  const byPath = Object.fromEntries(status.files.map((f: { path: string; state: string }) => [f.path, f]));
  assert.equal(byPath["moved.fig"].state, "new");
  assert.equal(byPath["moved.fig"].oldPath, undefined);
  assert.equal(byPath["moved.pen"].state, "deleted");
});

test("compare across a pen->fig rename lists an add and a delete, and restore of a mixed version brings both back", async () => {
  const repo = ["--repo", fx.path];
  const before = (await git(fx.path, "rev-parse", "HEAD")).trim();
  const penBytes = await readFile(path.join(fx.path, "base.fig"));
  await copyFile(path.join(FIG, "head.fig"), path.join(fx.path, "extra.fig"));
  assert.equal((await design(["save", "-m", "Rename to fig", ...repo])).code, 0);
  const after = (await git(fx.path, "rev-parse", "HEAD")).trim();
  assert.notEqual(before, after);

  const outDir = await mkdtemp(path.join(tmpdir(), "design-fig-rename-"));
  try {
    const compare = await design(["compare", before, after, "--out", outDir, ...repo, "--json"]);
    assert.equal(compare.code, 0, compare.stderr);
    const diff = JSON.parse(await readFile(path.join(outDir, "diff.json"), "utf8"));
    const paths = diff.files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, ["extra.fig", "extra.pen"]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }

  // Restore a version holding both formats (base.fig + extra.pen) over the current one.
  const restore = await design(["restore", before, ...repo]);
  assert.equal(restore.code, 0, restore.stderr);
  const status = JSON.parse((await design(["status", ...repo, "--json"])).stdout);
  const byPath = Object.fromEntries(status.files.map((f: { path: string; state: string }) => [f.path, f.state]));
  assert.equal(byPath["extra.fig"], "deleted");
  assert.equal(byPath["extra.pen"], "new");
  assert.deepEqual(await readFile(path.join(fx.path, "base.fig")), penBytes);
});
