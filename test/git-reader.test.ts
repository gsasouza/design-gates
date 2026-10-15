import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  buildPathspecs,
  createGitReader,
  gitExecOptions,
  MAX_BUFFER,
  parseNameStatus,
  type GitExec,
} from "../src/git/exec.js";
import { defaultBase, InvalidRefError, WORKTREE } from "../src/git/reader.js";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";

const run = promisify(execFile);
const SHA = "a".repeat(40);

function fakeExec(responses: (args: string[]) => string) {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push(args);
    if (args.includes("rev-parse")) return `${SHA}\n`;
    return responses(args);
  };
  return { calls, exec };
}

describe("git reader (fake exec)", () => {
  it("parses -z name-status output including renames", () => {
    const out = "A\0new.pen\0D\0gone.pen\0M\0dir/a b.pen\0R087\0old/x.pen\0new/x.pen\0T\0t.pen\0";
    assert.deepEqual(parseNameStatus(out), [
      { path: "new.pen", status: "added" },
      { path: "gone.pen", status: "removed" },
      { path: "dir/a b.pen", status: "modified" },
      { path: "new/x.pen", oldPath: "old/x.pen", status: "renamed" },
      { path: "t.pen", status: "modified" },
    ]);
    assert.deepEqual(parseNameStatus(""), []);
  });

  it("builds glob pathspecs", () => {
    assert.deepEqual(buildPathspecs(["a/**"]), [":(glob)a/**"]);
  });

  it("builds the default .pen pathspec only when no globs are given", () => {
    assert.deepEqual(buildPathspecs([]), [":(glob)**/*.pen"]);
  });

  it("only returns .pen paths even when git lists other files for user globs", async () => {
    const { exec } = fakeExec((args) =>
      args.includes("ls-files")
        ? "screens/u.pen\0screens/u.txt\0"
        : "M\0screens/a.pen\0M\0screens/notes.txt\0R100\0screens/o.pen\0screens/o.txt\0R100\0screens/p.txt\0screens/p.pen\0",
    );
    const reader = createGitReader("/repo", exec);
    for (const head of ["head", WORKTREE] as const) {
      const files = await reader.listChangedPenFiles("base", head, ["screens/**"]);
      assert.ok(files.length > 0);
      for (const f of files) {
        assert.ok(f.path.endsWith(".pen"), f.path);
        if (f.oldPath) assert.ok(f.oldPath.endsWith(".pen"), f.oldPath);
      }
    }
  });

  it("builds ref-to-ref diff arguments", async () => {
    const { calls, exec } = fakeExec(() => "M\0a.pen\0");
    const files = await createGitReader("/repo", exec).listChangedPenFiles("base", "head", ["x/*.pen"]);
    assert.deepEqual(files, [{ path: "a.pen", status: "modified" }]);
    assert.deepEqual(calls[0], [
      "--no-optional-locks", "rev-parse", "--verify", "--end-of-options", "base^{commit}",
    ]);
    assert.deepEqual(calls[2], [
      "--no-optional-locks", "diff", "--name-status", "-M", "-z", SHA, SHA,
      "--", ":(glob)x/*.pen",
    ]);
  });

  it("builds worktree diff and untracked arguments", async () => {
    const { calls, exec } = fakeExec((args) => (args.includes("ls-files") ? "n.pen\0m.pen\0" : "M\0m.pen\0"));
    const files = await createGitReader("/repo", exec).listChangedPenFiles("base", WORKTREE, []);
    assert.deepEqual(files.map((f) => `${f.status}:${f.path}`), ["modified:m.pen", "added:n.pen"]);
    assert.deepEqual(calls[1], [
      "--no-optional-locks", "diff", "--name-status", "-M", "-z", SHA,
      "--", ":(glob)**/*.pen",
    ]);
    assert.deepEqual(calls[2], [
      "--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z",
      "--", ":(glob)**/*.pen",
    ]);
  });

  it("rejects refs starting with '-' without running git", async () => {
    const { calls, exec } = fakeExec(() => "");
    const reader = createGitReader("/repo", exec);
    await assert.rejects(reader.listChangedPenFiles("--output=x", "head", []), (e: unknown) => {
      assert.ok(e instanceof InvalidRefError);
      assert.equal(e.ref, "--output=x");
      return true;
    });
    await assert.rejects(reader.readBlob("-p", "a.pen"), InvalidRefError);
    assert.equal(calls.length, 0);
  });

  it("uses git show ref:path and merge-base main HEAD for defaults", async () => {
    const { calls, exec } = fakeExec((args) => (args.includes("merge-base") ? `${SHA}\n` : "blob"));
    const reader = createGitReader("/repo", exec);
    assert.equal(await reader.readBlob("head", "a.pen"), "blob");
    assert.deepEqual(calls[1], ["--no-optional-locks", "show", `${SHA}:a.pen`]);
    assert.equal(await defaultBase(reader), SHA);
    assert.deepEqual(calls.at(-1), ["--no-optional-locks", "merge-base", SHA, SHA]);
    assert.deepEqual(calls.at(-3), [
      "--no-optional-locks", "rev-parse", "--verify", "--end-of-options", "main^{commit}",
    ]);
  });

  it("runs git without a shell, with optional locks off and a large buffer", () => {
    const opts = gitExecOptions("/repo");
    assert.equal(opts.shell, false);
    assert.equal(opts.env.GIT_OPTIONAL_LOCKS, "0");
    assert.ok(opts.maxBuffer >= 256 * 1024 * 1024);
    assert.equal(MAX_BUFFER, opts.maxBuffer);
  });
});

describe("git reader (real git, globs)", () => {
  let repo: FixtureRepo;
  before(async () => {
    repo = await createFixtureRepo();
  });
  after(async () => {
    await repo.cleanup();
  });

  it("returns only screens/a.pen for a screens/** glob (committed and worktree)", async () => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com",
    };
    const g = (...args: string[]) =>
      run("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo.path, env });
    await mkdir(path.join(repo.path, "screens"), { recursive: true });
    await writeFile(path.join(repo.path, "screens", "a.pen"), "{}\n");
    await writeFile(path.join(repo.path, "screens", "notes.txt"), "n\n");
    await g("add", "-A");
    await g("commit", "-m", "screens");
    const reader = createGitReader(repo.path);
    assert.deepEqual(await reader.listChangedPenFiles("head", "HEAD", ["screens/**"]), [
      { path: "screens/a.pen", status: "added" },
    ]);
    await writeFile(path.join(repo.path, "screens", "a.pen"), '{"x":1}\n');
    await writeFile(path.join(repo.path, "screens", "notes.txt"), "changed\n");
    await writeFile(path.join(repo.path, "screens", "new.txt"), "u\n");
    assert.deepEqual(await reader.listChangedPenFiles("head", WORKTREE, ["screens/**"]), [
      { path: "screens/a.pen", status: "added" },
    ]);
  });
});

describe("git reader (real git)", () => {
  let repo: FixtureRepo;
  before(async () => {
    repo = await createFixtureRepo();
  });
  after(async () => {
    await repo.cleanup();
  });

  const gitIn = async (...args: string[]) => (await run("git", ["--no-optional-locks", ...args], { cwd: repo.path })).stdout;

  it("reports added, removed, modified and renamed files", async () => {
    const files = await createGitReader(repo.path).listChangedPenFiles("base", "head", []);
    const by = (p: string) => files.find((f) => f.path === p);
    assert.deepEqual(by("added.pen"), { path: "added.pen", status: "added" });
    assert.deepEqual(by("removed.pen"), { path: "removed.pen", status: "removed" });
    assert.deepEqual(by("fill.pen"), { path: "fill.pen", status: "modified" });
    assert.deepEqual(by("new/renamed.pen"), {
      path: "new/renamed.pen", oldPath: "old/renamed.pen", status: "renamed",
    });
    assert.equal(by("unchanged.pen"), undefined);
  });

  it("defaults the base to the merge base of main and HEAD", async () => {
    const reader = createGitReader(repo.path);
    assert.equal(await defaultBase(reader), (await gitIn("rev-parse", "HEAD")).trim());
  });

  it("throws a typed error for an invalid ref", async () => {
    const reader = createGitReader(repo.path);
    await assert.rejects(reader.listChangedPenFiles("nope", "head", []), (e: unknown) => {
      assert.ok(e instanceof InvalidRefError);
      assert.equal(e.ref, "nope");
      assert.match(e.message, /nope/);
      return true;
    });
    await assert.rejects(reader.readBlob("--upload-pack=x", "a"), InvalidRefError);
  });

  it("reads a blob from a ref", async () => {
    const text = await createGitReader(repo.path).readBlob("head", "added.pen");
    assert.equal(text, await readFile(path.join(repo.path, "added.pen"), "utf8"));
  });

  describe("worktree", () => {
    before(async () => {
      await writeFile(path.join(repo.path, "untracked.pen"), "{}\n");
      await writeFile(path.join(repo.path, "ignored.txt"), "x\n");
      await writeFile(path.join(repo.path, "fill.pen"), (await readFile(path.join(repo.path, "fill.pen"), "utf8")) + "\n");
    });

    it("reports tracked changes and untracked files as added", async () => {
      const files = await createGitReader(repo.path).listChangedPenFiles("head", WORKTREE, []);
      assert.deepEqual(files.map((f) => `${f.status}:${f.path}`).sort(), [
        "added:untracked.pen",
        "modified:fill.pen",
      ]);
    });

    it("narrows to user globs without returning non-.pen files", async () => {
      await mkdir(path.join(repo.path, "docs"), { recursive: true });
      await writeFile(path.join(repo.path, "docs", "spec.md"), "# x\n");
      await writeFile(path.join(repo.path, "docs", "n.pen"), "{}\n");
      const reader = createGitReader(repo.path);
      const withGlob = await reader.listChangedPenFiles("head", WORKTREE, ["docs/**"]);
      assert.deepEqual(withGlob, [{ path: "docs/n.pen", status: "added" }]);
    });

    it("leaves status, HEAD and .git/index untouched", async () => {
      const indexPath = path.join(repo.path, ".git", "index");
      const before = { status: await gitIn("status", "--porcelain"), head: await gitIn("rev-parse", "HEAD") };
      const bytes = await readFile(indexPath);
      const mtime = (await stat(indexPath)).mtimeMs;
      await createGitReader(repo.path).listChangedPenFiles("base", WORKTREE, []);
      assert.deepEqual(await readFile(indexPath), bytes);
      assert.equal((await stat(indexPath)).mtimeMs, mtime);
      assert.equal(await gitIn("status", "--porcelain"), before.status);
      assert.equal(await gitIn("rev-parse", "HEAD"), before.head);
    });

    it("reads worktree files and refuses to escape the repo", async () => {
      const reader = createGitReader(repo.path);
      assert.equal(await reader.readWorktree("untracked.pen"), "{}\n");
      await assert.rejects(reader.readWorktree("../outside.pen"), /escapes/);
      await assert.rejects(reader.readWorktree(path.resolve(repo.path, "..", "x")), /escapes/);
      await mkdir(path.join(repo.path, "links"), { recursive: true });
      await symlink("/etc/hostname", path.join(repo.path, "links", "out.pen"));
      await assert.rejects(reader.readWorktree("links/out.pen"), /escapes/);
    });
  });

  it("reads a blob larger than 1 MiB", async () => {
    const big = randomBytes(900 * 1024).toString("hex"); // ~1.8 MiB of ascii
    await writeFile(path.join(repo.path, "big.pen"), big);
    await gitIn("add", "big.pen");
    await run("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "big"], {
      cwd: repo.path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com",
      },
    });
    assert.ok(big.length > 1024 * 1024);
    const text = await createGitReader(repo.path).readBlob("HEAD", "big.pen");
    assert.equal(text.length, big.length);
    assert.equal(text, big);
  });
});
