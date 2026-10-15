export interface LogEntry {
  sha: string;
  shortId: string;
  date: string;
  message: string;
  files: string[];
}

/** `log -z --name-only` format: a record separator, then sha, short id, ISO date and subject. */
export const LOG_FORMAT = "--format=%x1e%H%x1f%h%x1f%aI%x1f%s";

/** Parses `git log -z --name-only --format=LOG_FORMAT` output. */
export function parseLog(out: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const record of out.split("\x1e")) {
    if (record === "") continue;
    const nul = record.indexOf("\0");
    const header = nul === -1 ? record : record.slice(0, nul);
    const rest = nul === -1 ? "" : record.slice(nul + 1);
    const [sha, shortId, date, message] = header.split("\x1f");
    const files = rest.replace(/^\n/, "").split("\0").filter((f) => f !== "");
    entries.push({ sha, shortId, date, message: message ?? "", files });
  }
  return entries;
}

export interface Commit {
  sha: string;
  shortId: string;
  message: string;
}

/** Parses `--format=%H%x1f%h%x1f%s` lines. */
export function parseCommitLines(out: string): Commit[] {
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [sha, shortId, message] = l.split("\x1f");
      return { sha, shortId, message: message ?? "" };
    });
}

export const COMMIT_LINE_FORMAT = "--format=%H%x1f%h%x1f%s";
