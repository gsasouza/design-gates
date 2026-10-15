const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const FN_COLOR = /^(?:rgba?|hsla?)\(\s*-?\d*\.?\d+%?(?:\s*[,/ ]\s*-?\d*\.?\d+%?)*\s*\)$/;

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isColor(v: unknown): v is string {
  return typeof v === "string" && (HEX_COLOR.test(v) || FN_COLOR.test(v));
}

export function valueHtml(v: unknown): string {
  if (isColor(v)) {
    return `<span class="swatch" style="background:${esc(v)}"></span><code>${esc(v)}</code>`;
  }
  const text = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  return `<code>${esc(text)}</code>`;
}

/** Like valueHtml, but non-colour strings are quoted so they read as text in a sentence. */
export function lineValueHtml(v: unknown): string {
  return typeof v === "string" && !isColor(v) ? `<code>${esc(`'${v}'`)}</code>` : valueHtml(v);
}
