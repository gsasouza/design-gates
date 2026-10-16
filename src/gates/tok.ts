/** Properties TOK-001 can check. */
export const CONTROLLED_PROPS = ["cornerRadius", "effect.color", "fill", "fontFamily", "fontSize", "gap", "padding", "stroke", "strokeWidth"] as const;
export type ControlledProp = (typeof CONTROLLED_PROPS)[number];

export const isControlledProp = (name: string): name is ControlledProp => (CONTROLLED_PROPS as readonly string[]).includes(name);

/** Longest `/regex/` ignore entry accepted, and longest value it is tested against. */
export const MAX_IGNORE_LENGTH = 200;

/** The source of a `/regex/` ignore entry, or undefined when the entry is a plain string. */
export const regexSource = (entry: string): string | undefined => (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/") ? entry.slice(1, -1) : undefined);

/**
 * Best-effort check: true when a quantified group contains a quantifier at any depth, e.g. `(a+)+` or `((a+))+`.
 * Escaped characters and character classes are skipped. Alternation shapes such as `(a|aa)+` are not detected.
 */
export const hasNestedQuantifier = (source: string): boolean => {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push(false);
    else if (c === ")") {
      const inner = stack.pop() ?? false;
      const next = source[i + 1];
      const quantified = next === "+" || next === "*" || next === "{";
      if (quantified && inner) return true;
      if (stack.length > 0 && (inner || quantified)) stack[stack.length - 1] = true;
    } else if ((c === "+" || c === "*" || c === "{") && stack.length > 0) stack[stack.length - 1] = true;
  }
  return false;
};

const compiled = new Map<string, RegExp | null>();

/** Compiles a regex source once per process; null when it is invalid. */
function compileIgnore(source: string): RegExp | null {
  let re = compiled.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source);
    } catch {
      re = null;
    }
    compiled.set(source, re);
  }
  return re;
}

/** Colour as lowercase #rrggbbaa, or undefined when it is not a hex colour. */
export function normalizeColor(value: string): string | undefined {
  const m = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (!m) return undefined;
  let hex = (m[1] ?? "").toLowerCase();
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return hex.length === 6 ? `${hex}ff` : hex;
}

/** True when `value` is matched by an ignore list: plain strings (colours compared normalised) or `/regex/` entries. */
export function isIgnored(value: string | number, entries: readonly string[]): boolean {
  const text = String(value);
  const color = normalizeColor(text);
  for (const entry of entries) {
    const source = regexSource(entry);
    if (source === undefined) {
      if (entry === text || (color !== undefined && color === normalizeColor(entry))) return true;
      continue;
    }
    if (entry.length > MAX_IGNORE_LENGTH || text.length > MAX_IGNORE_LENGTH) continue;
    if (compileIgnore(source)?.test(text)) return true;
  }
  return false;
}
