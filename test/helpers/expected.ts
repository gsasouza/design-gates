import { readFileSync } from "node:fs";
import { fixtureUrl } from "./fixtures.js";

export type FileStatus = "added" | "removed" | "modified" | "renamed" | "unchanged";
export type ExpectedChange = "added" | "removed" | "modified" | "moved" | "reordered" | "none";

export interface ExpectedEntry {
  file: string;
  oldPath?: string;
  fileStatus: FileStatus;
  frameId: string;
  nodeId?: string;
  change: ExpectedChange;
  path?: string;
  matchedBy?: "id" | "name" | "structure";
  variable?: string;
  theme?: string;
}

/** Loads `fixtures/expected.json`. */
export function loadExpected(): ExpectedEntry[] {
  return JSON.parse(readFileSync(fixtureUrl("expected.json"), "utf8")) as ExpectedEntry[];
}
