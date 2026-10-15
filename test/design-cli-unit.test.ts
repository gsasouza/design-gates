import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runDesign, type DesignDeps } from "../src/design/run.js";
import { COMMANDS } from "../src/design/help.js";
import { VcsCommitFailedError, VcsRefusedError, VcsUsageError } from "../src/vcs/errors.js";
import type { DesignRepo } from "../src/vcs/repo.js";
import type { CompareOptions } from "../src/vcs/compare.js";

interface Harness {
  calls: [string, unknown][];
  out: string[];
  err: string[];
  run: (argv: string[]) => Promise<number>;
}

const REFS: Record<string, string> = { "#1": "a", "#2": "b", main: "m", abcd1234: "c" };

function harness(over: Partial<Record<keyof DesignRepo, (arg: any) => unknown>> = {}): Harness {
  const calls: [string, unknown][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const method = (name: string, result: unknown) => async (arg?: unknown) => {
    calls.push([name, arg]);
    const fn = over[name as keyof DesignRepo];
    return fn ? fn(arg) : result;
  };
  const repo = {
    init: method("init", { summary: "init done" }),
    status: method("status", { summary: "status done" }),
    save: method("save", { summary: "save done" }),
    history: method("history", {
      summary: "2 saved versions, newest first.",
      versions: [
        { number: 1, shortId: "aaaa", date: "d1", message: "second" },
        { number: 2, shortId: "bbbb", date: "d0", message: "first" },
      ],
    }),
    restore: method("restore", { summary: "restore done" }),
    explore: method("explore", { summary: "explore done" }),
    switchTo: method("switchTo", { summary: "switch done" }),
    resolveVersion: async (ref: string) => {
      if (ref === "dup") throw new VcsUsageError('"dup" could mean more than one thing: x; y.');
      if (ref.startsWith("#") && !(ref in REFS)) throw new VcsUsageError(`There is no version ${ref}.`);
      if (!(ref in REFS)) throw new VcsUsageError(`There is no version, exploration or "main" called "${ref}".`);
      return { sha: REFS[ref], shortId: REFS[ref], label: ref };
    },
  } as unknown as DesignRepo;
  const deps: DesignDeps = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    cwd: "/work/here",
    createRepo: (dir) => {
      calls.push(["createRepo", dir]);
      return repo;
    },
    compare: async (options: CompareOptions, d) => {
      calls.push(["compare", { options, repo: d.repo, hasOpener: d.openFile !== undefined }]);
      return { files: 1, frames: 1, changes: 2, reportPath: "/r/report.html", from: { sha: "a", shortId: "a", label: "#1" }, to: null, summary: "2 changes" };
    },
    opener: async () => {},
  };
  return { calls, out, err, run: (argv) => runDesign(argv, deps) };
}

const callOf = (h: Harness, name: string) => h.calls.find(([n]) => n === name)?.[1];

test("help text mentions every command and option, in all spellings", async () => {
  for (const argv of [["--help"], ["-h"], ["help"]]) {
    const h = harness();
    assert.equal(await h.run(argv), 0);
    const text = h.out.join("");
    for (const c of COMMANDS) assert.match(text, new RegExp(`\\b${c}\\b`), `${c} in help`);
    for (const o of ["--repo", "--json", "--message", "--limit", "--out", "--open", "--save-first", "#1", "main", "Exit codes"]) {
      assert.ok(text.includes(o), `${o} in help`);
    }
    assert.doesNotMatch(text, /\b(git|commit|branch|checkout|HEAD|SHA)\b/i);
  }
});

test("per-command --help prints that command's help and exits 0", async () => {
  const h = harness();
  assert.equal(await h.run(["save", "--help"]), 0);
  assert.match(h.out.join(""), /design save/);
  assert.equal(h.calls.length, 0);
});

test("--repo defaults to cwd and resolves relative to it", async () => {
  let h = harness();
  assert.equal(await h.run(["status"]), 0);
  assert.equal(callOf(h, "createRepo"), "/work/here");
  h = harness();
  await h.run(["status", "--repo", "sub"]);
  assert.equal(callOf(h, "createRepo"), path.resolve("/work/here", "sub"));
  assert.equal(h.out.join(""), "status done\n");
});

test("simple commands pass their arguments to the library", async () => {
  let h = harness();
  await h.run(["init"]);
  assert.deepEqual(h.calls.map(([n]) => n), ["createRepo", "init"]);
  h = harness();
  await h.run(["save"]);
  assert.deepEqual(callOf(h, "save"), {});
  h = harness();
  await h.run(["save", "-m", "Header tweak"]);
  assert.deepEqual(callOf(h, "save"), { message: "Header tweak" });
  h = harness();
  await h.run(["save", "--message", "Long"]);
  assert.deepEqual(callOf(h, "save"), { message: "Long" });
  h = harness();
  await h.run(["explore"]);
  assert.deepEqual(callOf(h, "explore"), {});
  h = harness();
  await h.run(["explore", "idea"]);
  assert.deepEqual(callOf(h, "explore"), { name: "idea" });
  h = harness();
  await h.run(["switch", "main"]);
  assert.equal(callOf(h, "switchTo"), "main");
});

test("history takes an optional file and limit and lists the versions", async () => {
  let h = harness();
  assert.equal(await h.run(["history"]), 0);
  assert.deepEqual(callOf(h, "history"), {});
  assert.equal(h.out.join(""), "2 saved versions, newest first.\n#1  aaaa  d1  second\n#2  bbbb  d0  first\n");
  h = harness();
  await h.run(["history", "a.pen", "--limit", "5"]);
  assert.deepEqual(callOf(h, "history"), { file: "a.pen", limit: 5 });
});

test("restore passes version, paths and --save-first", async () => {
  const h = harness();
  assert.equal(await h.run(["restore", "#2", "a.pen", "b.pen", "--save-first"]), 0);
  assert.deepEqual(callOf(h, "restore"), { version: "#2", paths: ["a.pen", "b.pen"], saveFirst: true });
  const h2 = harness();
  await h2.run(["restore", "#2"]);
  assert.deepEqual(callOf(h2, "restore"), { version: "#2" });
});

const compareOptions = async (argv: string[]) => {
  const h = harness();
  const code = await h.run(["compare", ...argv]);
  return { code, h, options: (callOf(h, "compare") as { options: CompareOptions } | undefined)?.options };
};

test("compare: leading positionals that resolve are versions, the rest are paths", async () => {
  assert.deepEqual((await compareOptions([])).options, { paths: [] });
  assert.deepEqual((await compareOptions(["#2"])).options, { from: "#2", paths: [] });
  assert.deepEqual((await compareOptions(["#2", "#1"])).options, { from: "#2", to: "#1", paths: [] });
  assert.deepEqual((await compareOptions(["#2", "#1", "a.pen"])).options, { from: "#2", to: "#1", paths: ["a.pen"] });
  assert.deepEqual((await compareOptions(["a.pen"])).options, { paths: ["a.pen"] });
  assert.deepEqual((await compareOptions(["#2", "a.pen", "#1"])).options, { from: "#2", paths: ["a.pen", "#1"] });
  assert.deepEqual((await compareOptions(["a.pen", "main"])).options, { paths: ["a.pen", "main"] });
  assert.deepEqual((await compareOptions(["#2", "#1", "main"])).options, { from: "#2", to: "#1", paths: ["main"] });
  assert.deepEqual((await compareOptions(["main", "abcd1234"])).options, { from: "main", to: "abcd1234", paths: [] });
});

test("compare: an ambiguous reference or an unknown #n is a usage error, not a path", async () => {
  for (const argv of [["dup"], ["#2", "dup"], ["#9"]]) {
    const r = await compareOptions(argv);
    assert.equal(r.code, 2);
    assert.equal(r.options, undefined);
    assert.ok(r.h.err.join("").length > 0);
  }
  const r = await compareOptions(["dup"]);
  assert.match(r.h.err.join(""), /more than one thing/);
});

test("compare: --out resolves against cwd, --open reaches the library, --repo is passed", async () => {
  const r = await compareOptions(["--out", "rep", "--open", "--repo", "x"]);
  assert.deepEqual(r.options, { paths: [], out: path.resolve("/work/here", "rep"), open: true });
  const c = callOf(r.h, "compare") as { repo: string; hasOpener: boolean };
  assert.equal(c.repo, path.resolve("/work/here", "x"));
  assert.equal(c.hasOpener, true);
});

test("--json prints exactly one JSON object with the library result", async () => {
  for (const argv of [["status"], ["history"], ["compare"], ["switch", "main"]]) {
    const h = harness();
    assert.equal(await h.run([...argv, "--json"]), 0);
    assert.equal(h.out.length, 1);
    assert.ok(h.out[0].endsWith("\n"));
    const parsed = JSON.parse(h.out[0]);
    assert.equal(typeof parsed.summary, "string");
  }
  const h = harness();
  await h.run(["history", "--json"]);
  assert.equal(JSON.parse(h.out[0]).versions.length, 2);
  assert.equal(h.err.length, 0);
});

test("usage errors exit 2 with a plain message on stderr", async () => {
  const cases: string[][] = [
    [],
    ["frobnicate"],
    ["status", "--nope"],
    ["status", "--limit", "3"],
    ["status", "extra"],
    ["restore"],
    ["switch"],
    ["switch", "a", "b"],
    ["history", "--limit", "abc"],
    ["save", "--message"],
    ["explore", "a", "b"],
  ];
  for (const argv of cases) {
    const h = harness();
    assert.equal(await h.run(argv), 2, argv.join(" "));
    assert.equal(h.out.length, 0);
    assert.ok(h.err.join("").length > 0);
  }
});

test("--json errors also print {error, code} on stdout", async () => {
  const h = harness();
  assert.equal(await h.run(["frobnicate", "--json"]), 2);
  assert.equal(h.out.length, 1);
  const parsed = JSON.parse(h.out[0]);
  assert.equal(parsed.code, 2);
  assert.match(parsed.error, /frobnicate/);
  assert.match(h.err.join(""), /frobnicate/);
});

test("library errors map to exit codes: usage 2, refused 1, commit failed 1 with the cause", async () => {
  let h = harness({ switchTo: () => { throw new VcsUsageError("There is no exploration called \"x\"."); } });
  assert.equal(await h.run(["switch", "x"]), 2);
  h = harness({ switchTo: () => { throw new VcsRefusedError("You have unsaved changes."); } });
  assert.equal(await h.run(["switch", "x"]), 1);
  assert.equal(h.err.join(""), "You have unsaved changes.\n");
  h = harness({ save: () => { throw new VcsCommitFailedError("Saving failed because a git hook rejected it: nope", "hook"); } });
  assert.equal(await h.run(["save"]), 1);
  assert.equal(h.err.join(""), "Saving failed because a git hook rejected it: nope\n");
  assert.equal(h.out.length, 0);
});

test("a failing commit in --json mode prints the error object", async () => {
  const h = harness({ save: () => { throw new VcsCommitFailedError("Saving failed: boom", "other"); } });
  assert.equal(await h.run(["save", "--json"]), 1);
  assert.deepEqual(JSON.parse(h.out[0]), { error: "Saving failed: boom", code: 1 });
});

test("unexpected errors exit 1 as `design: <message>`, also in --json", async () => {
  let h = harness({ status: () => { throw new Error("disk exploded"); } });
  assert.equal(await h.run(["status"]), 1);
  assert.equal(h.err.join(""), "design: disk exploded\n");
  h = harness({ status: () => { throw new Error("disk exploded"); } });
  assert.equal(await h.run(["status", "--json"]), 1);
  assert.deepEqual(JSON.parse(h.out[0]), { error: "design: disk exploded", code: 1 });
});
