import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/design/help.js";
import { OPTIONS } from "../src/design/run.js";

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "package.json not found above the test");
    dir = parent;
  }
  return dir;
}

const skillDir = path.join(findRoot(), "skills", "design-cli");
const skillFile = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const referenceFile = path.join(skillDir, "reference.md");
const skillText = skillFile + (existsSync(referenceFile) ? `\n${readFileSync(referenceFile, "utf8")}` : "");

test("the skill frontmatter has the name design-cli and a description", () => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skillFile);
  assert.ok(match, "SKILL.md starts with a --- frontmatter block");
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (m) fields.set(m[1], m[2].trim());
  }
  assert.equal(fields.get("name"), "design-cli");
  assert.notEqual(fields.get("description") ?? "", "");
});

test("the skill mentions every design command", () => {
  for (const c of COMMANDS.filter((x) => x !== "help")) {
    assert.ok(skillText.includes(`design ${c}`), `skill text mentions "design ${c}"`);
  }
});

test("every --flag in the skill is a real design option", () => {
  const flags = new Set([...skillText.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
  assert.ok(flags.size > 0);
  for (const f of flags) {
    assert.ok(f in OPTIONS, `--${f} is not a design option`);
  }
});
