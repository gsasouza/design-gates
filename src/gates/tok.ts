/** Properties TOK-001 can check. */
export const CONTROLLED_PROPS = ["cornerRadius", "effect.color", "fill", "fontFamily", "fontSize", "gap", "padding", "stroke", "strokeWidth"] as const;
export type ControlledProp = (typeof CONTROLLED_PROPS)[number];

export const isControlledProp = (name: string): name is ControlledProp => (CONTROLLED_PROPS as readonly string[]).includes(name);

/** Longest `/regex/` ignore entry accepted, and longest value it is tested against. */
export const MAX_IGNORE_LENGTH = 200;

/** The source of a `/regex/` ignore entry, or undefined when the entry is a plain string. */
export const regexSource = (entry: string): string | undefined => (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/") ? entry.slice(1, -1) : undefined);

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
    try {
      if (new RegExp(source).test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
