/** Properties TOK-001 checks; `stroke.fill` is accepted as an alias of `stroke`. */
export const CONTROLLED_PROPS = ["cornerRadius", "effect.color", "fill", "fontFamily", "fontSize", "gap", "padding", "stroke", "strokeWidth"] as const;
export type ControlledProp = (typeof CONTROLLED_PROPS)[number];

export function controlledProp(name: string): ControlledProp | undefined {
  const canonical = name === "stroke.fill" ? "stroke" : name;
  return (CONTROLLED_PROPS as readonly string[]).includes(canonical) ? (canonical as ControlledProp) : undefined;
}

/** Longest `/regex/` ignore entry accepted, and longest value it is tested against. */
export const MAX_IGNORE_LENGTH = 200;

export type IgnoreEntry = { regex: RegExp } | { literal: string };

/** `/pattern/` or `/pattern/i` is a regex; anything else is a literal. Returns an error message for a bad regex. */
export function parseIgnoreEntry(entry: string): IgnoreEntry | { error: string } {
  const m = /^\/(.+)\/(i?)$/s.exec(entry);
  if (!m) return { literal: entry };
  if (entry.length > MAX_IGNORE_LENGTH) return { error: `regex longer than ${MAX_IGNORE_LENGTH} characters` };
  // A quantified group is the classic catastrophic-backtracking shape; untrusted configs may not use it.
  if (/\)[*+{]/.test(m[1] ?? "")) return { error: "quantified groups are not allowed in regexes" };
  try {
    return { regex: new RegExp(m[1] ?? "", m[2]) };
  } catch {
    return { error: "invalid regex" };
  }
}

/** Colour as lowercase #rrggbbaa, or undefined when it is not a hex colour. */
export function normalizeColor(value: string): string | undefined {
  const m = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (!m) return undefined;
  let hex = (m[1] ?? "").toLowerCase();
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return hex.length === 6 ? `${hex}ff` : hex;
}

/** True when `value` of a controlled prop is matched by an ignore list (strings, colour-insensitive, or regexes). */
export function isIgnored(value: string | number, entries: readonly string[]): boolean {
  const text = String(value);
  const color = normalizeColor(text);
  for (const entry of entries) {
    const parsed = parseIgnoreEntry(entry);
    if ("error" in parsed) continue;
    if ("regex" in parsed) {
      if (text.length <= MAX_IGNORE_LENGTH && parsed.regex.test(text)) return true;
    } else if (parsed.literal === text || (color !== undefined && color === normalizeColor(parsed.literal))) return true;
  }
  return false;
}
