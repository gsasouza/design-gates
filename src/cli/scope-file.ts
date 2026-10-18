import type { GatesConfig } from "../gates/config.js";
import type { GitReader } from "../git/reader.js";
import { UsageError } from "./run-diff.js";

const isMissing = (err: unknown): boolean => (err as { code?: string } | null)?.code === "ENOENT";

/**
 * Replaces `rules.DIF-002.scope` with the list in the scope file, when DIF-002 is enabled and the file
 * exists. A missing file is fine at the default path and a usage error when the config names it.
 */
export async function applyScopeFile(git: GitReader, config: GatesConfig, explicit: boolean): Promise<void> {
  const rule = config.rules["DIF-002"];
  if (!rule.enabled || rule.severity === "off") return;
  const file = rule.scopeFile;
  let text: string;
  try {
    text = await git.readWorktree(file);
  } catch (err) {
    if (isMissing(err) && !explicit) return;
    throw new UsageError(`cannot read scope file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in scope file ${file}: ${(err as Error).message}`);
  }
  const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { scope?: unknown }).scope : undefined;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    throw new UsageError(`invalid scope file ${file}: expected {"scope": string[]}`);
  }
  rule.scope = list as string[];
}
