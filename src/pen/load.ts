import { readFile } from "node:fs/promises";
import type { PenDocument } from "./types.js";

/** Replace comments with whitespace and drop trailing commas, leaving string contents intact. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated block comment");
      out += " ";
      i = end + 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Parse `.pen` text (JSONC) into a PenDocument. Throws on invalid input. */
export function parsePen(text: string): PenDocument {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`Invalid .pen document: ${(err as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Invalid .pen document: root must be an object");
  }
  const doc = data as Record<string, unknown>;
  if (typeof doc.version !== "string") {
    throw new Error('Invalid .pen document: missing string "version"');
  }
  if (!Array.isArray(doc.children)) {
    throw new Error('Invalid .pen document: missing "children" array');
  }
  return doc as unknown as PenDocument;
}

/** Read and parse a `.pen` file. */
export async function loadPenFile(path: string | URL): Promise<PenDocument> {
  return parsePen(await readFile(path, "utf8"));
}
