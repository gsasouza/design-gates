import { ContractLoadError } from "./errors.js";

interface RawToken {
  value: unknown;
  type: string | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ALIAS = /^\{([^{}]+)\}$/;

const hex2 = (n: number): string => Math.round(n * 255).toString(16).padStart(2, "0");

function colorToString(value: Record<string, unknown>, path: string, fail: (r: string) => never): string {
  const { colorSpace, components, alpha, hex } = value;
  if (alpha !== undefined && !(typeof alpha === "number" && alpha >= 0 && alpha <= 1)) fail(`token ${path}: colour alpha must be a number between 0 and 1`);
  const a = typeof alpha === "number" ? alpha : 1;
  let base: string;
  if (hex !== undefined) {
    const m = typeof hex === "string" ? /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex) : null;
    if (!m) return fail(`token ${path}: colour hex must be #rgb, #rrggbb or #rrggbbaa`);
    const digits = m[1]!.toLowerCase();
    if (digits.length === 8) return `#${digits}`;
    base = `#${digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits}`;
  } else {
    if (colorSpace !== "srgb") return fail(`token ${path}: colour space ${JSON.stringify(colorSpace)} needs a hex value (only srgb is converted)`);
    if (!Array.isArray(components) || components.length !== 3 || !components.every((c) => typeof c === "number" && c >= 0 && c <= 1)) {
      return fail(`token ${path}: srgb colour components must be three numbers between 0 and 1`);
    }
    base = `#${components.map((c: number) => hex2(c)).join("")}`;
  }
  return a < 1 ? base + hex2(a) : base;
}

function valueToString(value: unknown, type: string | undefined, path: string, fail: (r: string) => never): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return type === "dimension" || type === "color" ? fail(`token ${path}: a ${type} must be ${type === "color" ? "a string or a colour object" : '{ "value": number, "unit": string }'}`) : String(value);
  }
  if (isObject(value) && (type === "color" || "colorSpace" in value)) return colorToString(value, path, fail);
  if (type === "color") return fail(`token ${path}: a colour must be a string or a colour object`);
  if (isObject(value) && "unit" in value) {
    if (typeof value.value !== "number" || !Number.isFinite(value.value) || typeof value.unit !== "string" || value.unit === "") {
      return fail(`token ${path}: a dimension must be { "value": number, "unit": string }`);
    }
    return `${value.value}${value.unit}`;
  }
  if (type === "dimension") return fail(`token ${path}: a dimension must be { "value": number, "unit": string }`);
  if (value === null || value === undefined) return fail(`token ${path}: invalid $value`);
  return JSON.stringify(value); // composite tokens (shadow, typography ...) are kept as JSON text
}

/**
 * Read a DTCG 2025.10 file into dotted token path -> value text. `$type` is inherited from the nearest group;
 * `{a.b}` aliases are resolved within the file; colours become hex (alpha appended below 1; srgb components
 * are converted, other colour spaces need `hex`); dimensions become `<value><unit>`; composite values are kept as JSON.
 */
export function readDtcg(text: string, file: string): Map<string, string> {
  const fail = (reason: string): never => {
    throw new ContractLoadError(file, reason);
  };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return fail(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isObject(root)) return fail("expected a JSON object of token groups");
  const tokens = new Map<string, RawToken>();
  const walk = (group: Record<string, unknown>, prefix: string, inherited: string | undefined): void => {
    const type = typeof group.$type === "string" ? group.$type : inherited;
    for (const [key, child] of Object.entries(group)) {
      if (key.startsWith("$")) continue;
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (key.includes(".") || key.includes("{") || key.includes("}")) fail(`invalid name "${key}" at ${path}`);
      if (!isObject(child)) fail(`${path} is neither a token nor a group`);
      const node = child as Record<string, unknown>;
      if ("$value" in node) tokens.set(path, { value: node.$value, type: typeof node.$type === "string" ? node.$type : type });
      else walk(node, path, type);
    }
  };
  walk(root, "", undefined);

  const resolved = new Map<string, string>();
  const resolve = (path: string, stack: string[]): string => {
    const done = resolved.get(path);
    if (done !== undefined) return done;
    const token = tokens.get(path)!;
    const alias = typeof token.value === "string" ? ALIAS.exec(token.value) : null;
    let out: string;
    if (alias) {
      const target = alias[1]!;
      if (stack.includes(target) || target === path) return fail(`alias cycle: ${[...stack, path, target].join(" -> ")}`);
      if (!tokens.has(target)) return fail(`token ${path}: alias {${target}} has no target`);
      out = resolve(target, [...stack, path]);
    } else out = valueToString(token.value, token.type, path, fail);
    resolved.set(path, out);
    return out;
  };
  for (const path of tokens.keys()) resolve(path, []);
  return resolved;
}
