import { ContractLoadError } from "./errors.js";

/**
 * Minimal CSS custom-property reader. Limits (also in the README):
 * - comments are stripped; strings and parentheses are respected when looking for braces and semicolons;
 * - a rule counts when its comma-separated selector list contains a configured selector exactly
 *   (every configured selector in the list receives the declarations)
 *   (compared after collapsing whitespace; `[data-theme=dark]` does not match `[data-theme="dark"]`);
 * - only `--name: value;` declarations directly in such a rule are read, values trimmed (`!important` is kept);
 *   other properties and nested rules inside it are ignored;
 * - the contents of every at-rule block (@media, @supports, @layer, @container ...) are skipped;
 * - a property repeated under the same selector, also across rules, takes the later value;
 * - `var()` references are not resolved.
 * Unbalanced braces or an unterminated string or comment are errors.
 */
export function readCssCustomProperties(text: string, selectors: readonly string[], file: string): Map<string, Map<string, string>> {
  const fail = (reason: string): never => {
    throw new ContractLoadError(file, reason);
  };
  const src = stripComments(text, fail);
  const wanted = new Set(selectors.map(normalize));
  const out = new Map<string, Map<string, string>>(selectors.map((s) => [s, new Map()]));
  const byNormal = new Map(selectors.map((s) => [normalize(s), s]));
  let pos = 0;
  while (pos < src.length) {
    const stop = scan(src, pos, ["{", ";", "}"], fail);
    if (stop === -1) {
      if (src.slice(pos).trim() !== "") fail("unexpected text after the last rule");
      break;
    }
    const c = src[stop]!;
    if (c === "}") return fail("unbalanced block: unexpected }");
    if (c === ";") {
      pos = stop + 1; // statement at-rule such as @import
      continue;
    }
    const prelude = src.slice(pos, stop).trim();
    const close = matchClose(src, stop, fail);
    pos = close + 1; // an at-rule block is consumed whole, so its contents are never read
    const hits = new Set(splitTop(prelude).map(normalize).filter((s) => wanted.has(s)));
    if (hits.size === 0) continue;
    const decls = declarations(src.slice(stop + 1, close), fail);
    for (const hit of hits) {
      const target = out.get(byNormal.get(hit)!)!;
      for (const [name, value] of decls) target.set(name, value);
    }
  }
  return out;
}

const normalize = (s: string): string => s.trim().replace(/\s+/g, " ");

function stripComments(text: string, fail: (r: string) => never): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end === -1) fail("unterminated string");
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) fail("unterminated comment");
      out += " ";
      i = end + 1;
    } else out += c;
  }
  return out;
}

/** Index of the closing quote of the string opening at `i`, or -1. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === s[i]) return j;
    else if (s[j] === "\n") return -1;
  }
  return -1;
}

/** First index >= from of one of `stops` outside strings and parentheses/brackets, or -1. */
function scan(s: string, from: number, stops: string[], fail: (r: string) => never): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(s, i);
      if (end === -1) fail("unterminated string");
      i = end;
    } else if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (depth === 0 && stops.includes(c)) return i;
  }
  return -1;
}

/** Index of the } matching the { at `open`. */
function matchClose(s: string, open: number, fail: (r: string) => never): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(s, i);
      if (end === -1) fail("unterminated string");
      i = end;
    } else if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return fail("unbalanced block: missing }");
}

function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

/** `--name: value` declarations directly inside a block body; nested blocks are skipped. */
function declarations(body: string, fail: (r: string) => never): [string, string][] {
  const out: [string, string][] = [];
  let pos = 0;
  while (pos < body.length) {
    const stop = scan(body, pos, [";", "{"], fail);
    const end = stop === -1 ? body.length : stop;
    if (stop !== -1 && body[stop] === "{") {
      pos = matchClose(body, stop, fail) + 1;
      continue;
    }
    const m = /^\s*(--[^\s:;{}]+)\s*:([\s\S]*)$/.exec(body.slice(pos, end));
    if (m) out.push([m[1]!, m[2]!.trim()]);
    pos = end + 1;
  }
  return out;
}
