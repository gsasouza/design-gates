import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { defaultDeps, runDiff } from "../src/cli/run-diff.js";
import { buildPathspecs, createGitReader, type GitExec, type GitExecBytes } from "../src/git/exec.js";
import { WORKTREE } from "../src/git/reader.js";
import { readDesignSource } from "../src/source/read.js";
import { bareFig, zipFig } from "./helpers/fig.js";

const run = promisify(execFile);
const SHA = "b".repeat(40);

function fakeExec(responses: (args: string[]) => string) {
  const exec: GitExec = async (args) => (args.includes("rev-parse") ? `${SHA}\n` : responses(args));
  return exec;
}

const NON_UTF8 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0xc0, 0x00, 0xed, 0xa0, 0x80, 0xf8, 0x0a]);

describe("design file discovery", () => {
  it("covers .pen and .fig by default and honours explicit globs", () => {
    assert.deepEqual(buildPathspecs([]), [":(glob)**/*.pen", ":(glob)**/*.fig"]);
    assert.deepEqual(buildPathspecs(["a/**"]), [":(glob)a/**"]);
  });

  it("keeps .pen and .fig files, drops other files, and splits renames across formats", async () => {
    const nameStatus =
      "M\0a.fig\0M\0b.pen\0M\0c.txt\0" +
      "R100\0old.pen\0new.fig\0" + // pen -> fig
      "R100\0old2.fig\0new2.pen\0" + // fig -> pen
      "R100\0dir/x.fig\0other/x.fig\0" + // fig -> fig stays a rename
      "R100\0dir/y.pen\0other/y.pen\0" + // pen -> pen stays a rename
      "R100\0g.fig\0g.png\0" +
      "R100\0h.png\0h.fig\0";
    const reader = createGitReader("/repo", fakeExec((args) => (args.includes("ls-files") ? "u.fig\0u.pen\0u.txt\0" : nameStatus)));
    const expected = [
      { path: "a.fig", status: "modified" },
      { path: "b.pen", status: "modified" },
      { path: "old.pen", status: "removed" },
      { path: "new.fig", status: "added" },
      { path: "old2.fig", status: "removed" },
      { path: "new2.pen", status: "added" },
      { path: "other/x.fig", oldPath: "dir/x.fig", status: "renamed" },
      { path: "other/y.pen", oldPath: "dir/y.pen", status: "renamed" },
      { path: "g.fig", status: "removed" },
      { path: "h.fig", status: "added" },
    ];
    assert.deepEqual(await reader.listChangedDesignFiles("base", "head", []), expected);
    assert.deepEqual(await reader.listChangedDesignFiles("base", WORKTREE, []), [
      ...expected,
      { path: "u.fig", status: "added" },
      { path: "u.pen", status: "added" },
    ]);
  });
});

describe("binary-safe reads", () => {
  it("returns blob bytes from the byte exec seam untouched, with the same ref validation", async () => {
    const calls: string[][] = [];
    const execBytes: GitExecBytes = async (args) => {
      calls.push(args);
      return NON_UTF8;
    };
    const reader = createGitReader("/repo", fakeExec(() => ""), execBytes);
    const out = await reader.readBlobBytes("head", "a.fig");
    assert.ok(Buffer.isBuffer(out));
    assert.ok(out.equals(NON_UTF8));
    assert.deepEqual(calls, [["--no-optional-locks", "show", `${SHA}:a.fig`]]);
    await assert.rejects(reader.readBlobBytes("-p", "a.fig"), /Invalid git ref/);
    assert.equal(calls.length, 1);
  });

  describe("real git", () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
    async function repoWith(files: Record<string, Buffer>): Promise<{ dir: string; git: (...a: string[]) => Promise<unknown> }> {
      const dir = await mkdtemp(path.join(tmpdir(), "design-gates-fig-"));
      const git = (...args: string[]) => run("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env });
      await git("init", "-b", "main");
      for (const [name, data] of Object.entries(files)) await writeFile(path.join(dir, name), data);
      await git("add", "-A");
      await git("commit", "-m", "files");
      return { dir, git };
    }

    it("round-trips a non-utf8 .fig through the blob and worktree byte reads", async () => {
      const { dir } = await repoWith({ "a.fig": NON_UTF8 });
      try {
        const reader = createGitReader(dir);
        const blob = await reader.readBlobBytes("HEAD", "a.fig");
        assert.ok(Buffer.isBuffer(blob));
        assert.ok(blob.equals(NON_UTF8));
        assert.ok((await reader.readWorktreeBytes("a.fig")).equals(NON_UTF8));
        await assert.rejects(reader.readWorktreeBytes("../outside.fig"), /escapes/);
        // The text read is lossy for these bytes, which is why .fig never uses it.
        assert.notEqual(Buffer.from(await reader.readBlob("HEAD", "a.fig"), "utf8").length, NON_UTF8.length);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("loads a committed zip-wrapped .fig as a source through the reader", async () => {
      const zipped = zipFig(await bareFig([{ id: "a", name: "A", fill: "#ff0000" }]));
      const { dir } = await repoWith({ "d.fig": zipped });
      try {
        const source = await readDesignSource(createGitReader(dir), "HEAD", "d.fig");
        assert.equal(source.format, "fig");
        assert.ok(JSON.stringify(source.doc).includes('"name":"A"'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("runDiff fails with exit code 1 and names the .fig when it cannot be parsed", async () => {
      const { dir, git } = await repoWith({ "d.fig": await bareFig([{ id: "a", name: "A", fill: "#ff0000" }]) });
      try {
        await git("tag", "base");
        await writeFile(path.join(dir, "d.fig"), Buffer.from("not a figma file"));
        await git("commit", "-am", "break");
        const err: string[] = [];
        const code = await runDiff({ repo: dir, base: "base", head: "HEAD", out: path.join(dir, "..", `out-${path.basename(dir)}`) }, { ...defaultDeps(), stdout: () => undefined, stderr: (t) => void err.push(t) });
        assert.equal(code, 1);
        assert.match(err.join(""), /Invalid \.fig document/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
