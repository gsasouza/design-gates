/** An sRGB colour with channels 0-255 and alpha 0-1; channels are kept unrounded. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; undefined for anything else. */
export function parseColor(value: unknown): Rgba | undefined {
  if (typeof value !== "string") return undefined;
  const m = HEX.exec(value);
  if (!m) return undefined;
  let hex = m[1]!;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const byte = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 };
}

/** Multiply the alpha by `factor` (clamped to 0-1). */
export function withOpacity(c: Rgba, factor: number): Rgba {
  return { ...c, a: c.a * Math.min(1, Math.max(0, factor)) };
}

/** Source-over compositing of `top` onto `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** WCAG 2.x relative luminance of the colour's channels (alpha ignored). */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio (1-21) between two colours; alpha ignored, composite first. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Large text per WCAG: 24px and up, or 18.66px and up when bold (weight 700+). */
export function isLargeText(fontSize: number, fontWeight: number): boolean {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
}
