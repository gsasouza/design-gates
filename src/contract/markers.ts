import { ContractLoadError } from "./errors.js";
import type { MarkerRef } from "./data.js";
import type { ContractReader } from "./reader.js";

const MAX_FILES = 10_000;
const MAX_BYTES = 1024 * 1024;
const BINARY_SNIFF = 8 * 1024;
/** Characters of a .pen id (and a .fig GUID such as `1:2`); never `/` or whitespace. */
const ID_TOKEN = "([A-Za-z0-9_:~.-]+)";

const escapeLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");

/** A global matcher whose capture group 1 is the id; the rest of the pattern is matched literally. */
export function markerMatcher(pattern: string): RegExp {
  const [before, after, ...extra] = pattern.split("<id>");
  if (before === undefined || after === undefined || extra.length > 0) throw new ContractLoadError("rules.DIF-003.markerPattern", "must contain exactly one <id> placeholder");
  return new RegExp(escapeLiteral(before) + ID_TOKEN + escapeLiteral(after), "g");
}

/** Marker references per node id found in the files matching `globs`; binary, oversized and unreadable files are skipped. */
export async function loadMarkers(pattern: string, globs: string[], reader: ContractReader): Promise<Map<string, MarkerRef[]>> {
  const markers = new Map<string, MarkerRef[]>();
  if (globs.length === 0) return markers;
  const matcher = markerMatcher(pattern);
  const files = await reader.listFiles(globs);
  if (files.length > MAX_FILES) throw new ContractLoadError("contract.codeGlobs", `matches ${files.length} files; at most ${MAX_FILES} are scanned`);
  for (const file of files) {
    let text: string;
    try {
      text = await reader.readFile(file);
    } catch {
      continue;
    }
    if (Buffer.byteLength(text) > MAX_BYTES || text.slice(0, BINARY_SNIFF).includes("\0")) continue;
    text.split(/\r\n|\n|\r/).forEach((line, i) => {
      for (const m of line.matchAll(matcher)) {
        const id = m[1]!.replace(/\.+$/, "");
        if (id === "") continue;
        const refs = markers.get(id) ?? [];
        refs.push({ file, line: i + 1 });
        markers.set(id, refs);
      }
    });
  }
  return markers;
}
