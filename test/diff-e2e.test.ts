import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  computeSemanticDiff,
  computeSemanticDiffWithDocs,
  serializeDiff,
  type DiffResult,
} from "../src/index.js";
import { createGitReader } from "../src/git/exec.js";
import { InvalidRefError, type ChangedFile, type GitReader } from "../src/git/reader.js";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";
import { loadExpected } from "./helpers/expected.js";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await run("git", ["--no-optional-locks", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: GIT_ENV,
      maxBuffer: 256 * 1024 * 1024,
    })
  ).stdout;

const penText = (frameId: string, label: string): string =>
  JSON.stringify({
    version: "2.10",
    children: [{ type: "frame", id: frameId, name: "F", children: [{ type: "text", id: `${frameId}-t`, name: "T", content: label }] }],
  });

let fx: FixtureRepo;
let result: DiffResult;
let serialized: string;
let json: { files: { path: string; oldPath?: string; status: string; frames: any[] }[]; variables: any[] };

before(async () => {
  fx = await createFixtureRepo();
  result = await computeSemanticDiff({ repo: fx.path, base: "base", head: "head" });
  serialized = serializeDiff(result);
  json = JSON.parse(serialized);
});
after(async () => {
  await fx.cleanup();
});

test("every fixtures/expected.json entry appears in the serialized diff", () => {
  for (const e of loadExpected()) {
    const label = `${e.file}/${e.frameId}`;
    const file = json.files.find((f) => f.path === e.file);
    if (e.fileStatus === "unchanged") {
      assert.equal(file, undefined, `${label}: unchanged file must not be listed`);
      continue;
    }
    assert.ok(file, `${label}: file present`);
    assert.equal(file.status, e.fileStatus, `${label}: file status`);
    assert.equal(file.oldPath, e.oldPath, `${label}: oldPath`);
    const frame = file.frames.find((f) => f.id === e.frameId);
    assert.ok(frame, `${label}: frame present`);
    if (e.matchedBy !== undefined) assert.equal(frame.matchedBy, e.matchedBy, `${label}: matchedBy`);
    if (e.variable !== undefined) {
      const v = json.variables.find((x) => x.file === e.file && x.name === e.variable && x.theme === e.theme);
      assert.ok(v, `${label}: variable ${e.variable}`);
      assert.equal(v.change, e.change, `${label}: variable change`);
      assert.ok(
        v.frames.some((r: { file: string; frameId: string }) => r.file === e.file && r.frameId === e.frameId),
        `${label}: variable lists frame`,
      );
    } else if (e.nodeId !== undefined) {
      const matches = frame.nodes.filter((n: { id: string; change: string }) => n.id === e.nodeId && n.change === e.change);
      assert.equal(matches.length, 1, `${label}: node ${e.nodeId} ${e.change}`);
      if (e.path !== undefined) {
        assert.ok(
          matches[0].props.some((p: { path: string }) => p.path === e.path),
          `${label}: prop ${e.path}`,
        );
      }
    } else if (e.change === "none") {
      assert.equal(frame.status, "unchanged", `${label}: frame unchanged`);
      assert.deepEqual(frame.nodes, [], `${label}: no node changes`);
    } else {
      assert.equal(frame.status, e.change, `${label}: frame status`);
    }
  }
});

test("computeSemanticDiffWithDocs keys docs by result path and renames carry oldPath", async () => {
  const { result: r, docs } = await computeSemanticDiffWithDocs({ repo: fx.path, base: "base", head: "head" });
  assert.deepEqual(Object.keys(docs).sort(), r.files.map((f) => f.path).sort());
  assert.ok(docs["new/renamed.pen"]?.base && docs["new/renamed.pen"]?.head);
  assert.equal(docs["added.pen"]?.base, undefined);
  assert.equal(docs["removed.pen"]?.head, undefined);
  assert.equal(r.files.find((f) => f.path === "new/renamed.pen")?.oldPath, "old/renamed.pen");
  assert.equal(r.head.sha, (await git(fx.path, "rev-parse", "head^{commit}")).trim());
});

test("serialized output is byte-identical across runs", async () => {
  const again = serializeDiff(await computeSemanticDiff({ repo: fx.path, base: "base", head: "head" }));
  assert.equal(again, serialized);
});

test("diffing leaves git status and HEAD unchanged", async () => {
  const snapshot = async () => [await git(fx.path, "status", "--porcelain"), await git(fx.path, "rev-parse", "HEAD")];
  const before = await snapshot();
  const index = await readFile(path.join(fx.path, ".git", "index"));
  await computeSemanticDiff({ repo: fx.path, base: "base" });
  await computeSemanticDiff({ repo: fx.path, base: "base", head: "head" });
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await readFile(path.join(fx.path, ".git", "index")), index);
});

test("invalid refs are rejected with a typed error naming the ref", async () => {
  await assert.rejects(
    computeSemanticDiff({ repo: fx.path, base: "--upload-pack=x" }),
    (e: unknown) => e instanceof InvalidRefError && e.ref === "--upload-pack=x",
  );
  await assert.rejects(
    computeSemanticDiff({ repo: fx.path, base: "base", head: "no-such-ref" }),
    (e: unknown) => e instanceof InvalidRefError && e.ref === "no-such-ref",
  );
});

test("worktree is the default head: uncommitted edit and untracked .pen", async () => {
  const wt = await createFixtureRepo();
  try {
    const fill = path.join(wt.path, "fill.pen");
    const original = await readFile(fill, "utf8");
    await writeFile(fill, original.replace(/"#[0-9a-fA-F]{6}"/, '"#123456"'));
    await mkdir(path.join(wt.path, "sub"), { recursive: true });
    await writeFile(path.join(wt.path, "sub", "fresh.pen"), penText("fresh-frame", "hi"));
    await writeFile(path.join(wt.path, "notes.txt"), "ignored");
    const statusBefore = await git(wt.path, "status", "--porcelain");

    const r = await computeSemanticDiff({ repo: wt.path, base: "head" });
    assert.equal(r.head.sha, "WORKTREE");
    assert.deepEqual(r.files.map((f) => [f.path, f.status]), [["fill.pen", "modified"], ["sub/fresh.pen", "added"]]);
    const fillFrame = r.files[0]!.frames.find((f) => f.id === "fill-frame")!;
    assert.equal(fillFrame.status, "modified");
    assert.equal(fillFrame.nodes[0]!.id, "fill-rect");
    assert.equal(r.files[1]!.frames[0]!.status, "added");
    assert.equal(await git(wt.path, "status", "--porcelain"), statusBefore);
  } finally {
    await wt.cleanup();
  }
});

test("a blob larger than 1 MiB is read through the real execFile wrapper", async () => {
  const big = await createFixtureRepo();
  try {
    const text = penText("big-frame", "x".repeat(2 * 1024 * 1024));
    await writeFile(path.join(big.path, "big.pen"), text);
    await git(big.path, "add", "-A");
    await git(big.path, "commit", "-m", "big");
    const read = await createGitReader(big.path).readBlob("HEAD", "big.pen");
    assert.equal(read.length, text.length);
    const r = await computeSemanticDiff({ repo: big.path, base: "head", head: "HEAD" });
    assert.equal(r.files[0]!.path, "big.pen");
    assert.equal(r.files[0]!.status, "added");
  } finally {
    await big.cleanup();
  }
});

test("orchestration with a fake GitReader", async () => {
  const calls: string[] = [];
  const blobs: Record<string, string> = {
    "BASE:old.pen": penText("f", "before"),
    "BASE:gone.pen": penText("g", "x"),
    "HEADSHA:a.pen": penText("n", "x"),
    "HEADSHA:new.pen": penText("f", "after"),
  };
  const files: ChangedFile[] = [
    { path: "new.pen", oldPath: "old.pen", status: "renamed" },
    { path: "a.pen", status: "added" },
    { path: "gone.pen", status: "removed" },
  ];
  const fake: GitReader = {
    async mergeBase(a, b) {
      calls.push(`mergeBase ${a} ${b}`);
      return a === "main" ? "BASE" : a === "feature" ? "HEADSHA" : a;
    },
    async listChangedPenFiles(base, head, globs) {
      calls.push(`list ${base} ${String(head)} ${globs.join(",")}`);
      return files;
    },
    async readBlob(ref, p) {
      calls.push(`blob ${ref}:${p}`);
      const b = blobs[`${ref}:${p}`];
      if (b === undefined) throw new Error(`unexpected read ${ref}:${p}`);
      return b;
    },
    async readWorktree() {
      throw new Error("worktree must not be read");
    },
  };
  const { result: r, docs } = await computeSemanticDiffWithDocs({
    repo: "/nonexistent",
    head: "feature",
    paths: ["**/*.pen"],
    git: fake,
  });
  assert.equal(r.base.sha, "BASE");
  assert.equal(r.head.sha, "HEADSHA");
  assert.ok(calls.includes("list BASE HEADSHA **/*.pen"));
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.oldPath]), [
    ["a.pen", "added", undefined],
    ["gone.pen", "removed", undefined],
    ["new.pen", "renamed", "old.pen"],
  ]);
  assert.deepEqual(r.files[0]!.frames.map((f) => f.status), ["added"]);
  assert.deepEqual(r.files[1]!.frames.map((f) => f.status), ["removed"]);
  const renamed = r.files[2]!.frames[0]!;
  assert.equal(renamed.status, "modified");
  assert.equal(renamed.matchedBy, "id");
  assert.deepEqual(renamed.counts, { added: 0, removed: 0, modified: 1, moved: 0, reordered: 0 });
  assert.deepEqual(renamed.changeBoxes, []);
  assert.deepEqual(renamed.missingBoxes, []);
  assert.equal(renamed.pixelDiffRatio, null);
  assert.equal(renamed.images, null);
  assert.deepEqual(Object.keys(docs).sort(), ["a.pen", "gone.pen", "new.pen"]);
  assert.ok(calls.includes("blob BASE:old.pen"));
});
