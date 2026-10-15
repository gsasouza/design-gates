import type {
  DiffResult,
  FileDiff,
  FrameCounts,
  FrameDiff,
  NodeChange,
  NodeChangeKind,
  PropChange,
  ThemeChange,
  VariableChange,
} from "../diff/model.js";
import { esc, lineValueHtml } from "./html.js";

export const KINDS = ["added", "removed", "modified", "moved", "reordered"] as const;

/** Variable and theme changes that list a frame as affected. */
export interface FrameRefs {
  variables: VariableChange[];
  themes: ThemeChange[];
}

export interface ChangeLine {
  kind: string;
  nodeId?: string;
  html: string;
}

export interface RenderedFrame {
  file: FileDiff;
  frame: FrameDiff;
  index: number;
  refs: FrameRefs;
}

export function frameRefs(result: DiffResult, file: FileDiff, frame: FrameDiff): FrameRefs {
  const ids = [frame.id, frame.baseId, frame.headId];
  const hit = (frames: { file: string; frameId: string }[]) =>
    frames.some((r) => r.file === file.path && ids.includes(r.frameId));
  return {
    variables: result.variables.filter((v) => hit(v.frames)),
    themes: result.themes.filter((t) => hit(t.frames)),
  };
}

export function hasRefs(refs: FrameRefs): boolean {
  return refs.variables.length > 0 || refs.themes.length > 0;
}

/** True when the semantic diff (nodes, frame add/remove, variables, themes) reports a change. */
export function hasSemanticChange(frame: FrameDiff, refs: FrameRefs): boolean {
  return frame.nodes.length > 0 || frame.status === "added" || frame.status === "removed" || hasRefs(refs);
}

/** The header status; an "unchanged" frame that is only here via a variable or theme says so. */
export function statusLabel(frame: FrameDiff, refs: FrameRefs): string {
  if (frame.status !== "unchanged") return frame.status;
  const parts: string[] = [];
  const vars = [...new Set(refs.variables.map((v) => v.name))];
  if (vars.length) parts.push(`variable ${vars.join(", ")}`);
  const themes = [...new Set(refs.themes.map((t) => t.name))];
  if (themes.length) parts.push(`theme ${themes.join(", ")}`);
  if (parts.length) return `changed via ${parts.join(" and ")}`;
  return frame.nodes.length > 0 ? "modified" : "unchanged";
}

function label(n: { name: string; id: string }): string {
  return n.name !== "" ? n.name : n.id;
}

/** Resolves a parent id using the names known in the result: nodes, the frame, sibling frames. */
function parentName(file: FileDiff, frame: FrameDiff, id: string | undefined): string {
  if (id === undefined) return "";
  const node = frame.nodes.find((n) => n.id === id);
  if (node && node.name !== "") return node.name;
  const own = [frame, ...file.frames.filter((f) => f !== frame)];
  for (const f of own) {
    if ([f.id, f.baseId, f.headId].includes(id) && f.name !== "") return f.name;
  }
  return id;
}

/** Absolute delta with at most two decimals and no trailing zeros. */
function px(n: number): string {
  return `${Number(Math.abs(n).toFixed(2))}px`;
}

const isNum = (p: PropChange | undefined): p is PropChange =>
  p !== undefined && typeof p.old === "number" && typeof p.new === "number";

function moveText(props: PropChange[]): string {
  const dx = props.find((p) => p.path === "x");
  const dy = props.find((p) => p.path === "y");
  const parts: string[] = [];
  if (isNum(dx) && px(dx.new as number - (dx.old as number)) !== "0px") {
    parts.push(`${px(dx.new as number - (dx.old as number))} ${(dx.new as number) > (dx.old as number) ? "right" : "left"}`);
  }
  if (isNum(dy) && px(dy.new as number - (dy.old as number)) !== "0px") {
    parts.push(`${px(dy.new as number - (dy.old as number))} ${(dy.new as number) > (dy.old as number) ? "down" : "up"}`);
  }
  return parts.join(", ");
}

function propLines(node: NodeChange): ChangeLine[] {
  const name = esc(label(node));
  const move = moveText(node.props ?? []);
  const lines: ChangeLine[] = [];
  let moveDone = false;
  for (const p of node.props ?? []) {
    // Numeric x/y changes collapse into one "moved" line (none at all when the delta rounds to 0).
    if ((p.path === "x" || p.path === "y") && isNum(p)) {
      if (!moveDone && move !== "") lines.push({ kind: node.change, nodeId: node.id, html: `${name} moved ${esc(move)}` });
      moveDone = true;
      continue;
    }
    lines.push({
      kind: node.change,
      nodeId: node.id,
      html: `${name} / ${esc(p.path)}: ${lineValueHtml(p.old)} -&gt; ${lineValueHtml(p.new)}`,
    });
  }
  return lines;
}

function nodeLines(file: FileDiff, frame: FrameDiff, node: NodeChange): ChangeLine[] {
  const name = esc(label(node));
  const head = (text: string): ChangeLine => ({ kind: node.change, nodeId: node.id, html: text });
  const kind: NodeChangeKind = node.change;
  if (kind === "added") return [head(`${name} added`)];
  if (kind === "removed") return [head(`${name} removed`)];
  const lines: ChangeLine[] = [];
  if (kind === "moved") {
    const from = esc(parentName(file, frame, node.from));
    const to = esc(parentName(file, frame, node.to));
    lines.push(head(`${name} moved from ${from} to ${to}`));
  } else if (kind === "reordered") {
    lines.push(head(`${name} reordered`));
  }
  return [...lines, ...propLines(node)];
}

function variableLines(refs: FrameRefs): ChangeLine[] {
  const lines: ChangeLine[] = [];
  for (const v of refs.variables) {
    const theme = v.theme ? ` (${esc(v.theme)})` : "";
    const name = `variable ${esc(v.name)}${theme}`;
    let html: string;
    if (v.change === "added") html = `${name} added: ${lineValueHtml(v.new)}`;
    else if (v.change === "removed") html = `${name} removed: ${lineValueHtml(v.old)}`;
    else html = `${name}: ${lineValueHtml(v.old)} -&gt; ${lineValueHtml(v.new)}`;
    lines.push({ kind: "variable", html });
  }
  for (const t of refs.themes) lines.push({ kind: "theme", html: `theme ${esc(t.name)} ${t.change}` });
  return lines;
}

export function changeLines(file: FileDiff, frame: FrameDiff, refs: FrameRefs): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (frame.status === "added" || frame.status === "removed") {
    lines.push({ kind: frame.status, html: `${esc(label(frame))} frame ${frame.status}` });
  }
  for (const node of frame.nodes) lines.push(...nodeLines(file, frame, node));
  return [...lines, ...variableLines(refs)];
}

export function changeListHtml(lines: ChangeLine[]): string {
  if (lines.length === 0) return "";
  let h = `<ul class="change-list">`;
  for (const l of lines) {
    const id = l.nodeId !== undefined ? ` data-node-id="${esc(l.nodeId)}"` : "";
    h += `<li${id} data-kind="${esc(l.kind)}"><button type="button" class="change-line">${l.html}</button></li>`;
  }
  return h + "</ul>";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The "N changes in M frames: ..." block; each kind links to the first frame carrying it. */
export function summaryHtml(result: DiffResult, rendered: RenderedFrame[]): string {
  const totals: FrameCounts = { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 };
  const first: Partial<Record<(typeof KINDS)[number], number>> = {};
  let frames = 0;
  for (const { frame, index, refs } of rendered) {
    const own = { ...frame.counts };
    // A whole-frame add or remove has no node counts; it counts as one change of that kind.
    if (frame.status === "added") own.added += 1;
    if (frame.status === "removed") own.removed += 1;
    let changed = hasRefs(refs);
    for (const k of KINDS) {
      totals[k] += own[k];
      if (own[k] > 0) {
        changed = true;
        first[k] ??= index;
      }
    }
    if (changed || frame.nodes.length > 0) frames++;
  }
  const kindTotal = KINDS.reduce((s, k) => s + totals[k], 0);
  const total = kindTotal + result.variables.length + result.themes.length;
  if (total === 0) return `<section id="summary"><p>No changes</p></section>`;
  const parts = KINDS.filter((k) => totals[k] > 0).map(
    (k) => `<a href="#frame-${first[k]}" data-kind="${k}">${totals[k]} ${k}</a>`,
  );
  if (result.variables.length > 0) {
    parts.push(`<span data-kind="variable">${plural(result.variables.length, "variable", "variables")} changed</span>`);
  }
  if (result.themes.length > 0) {
    parts.push(`<span data-kind="theme">${plural(result.themes.length, "theme", "themes")} changed</span>`);
  }
  return (
    `<section id="summary"><p><b>${plural(total, "change", "changes")} in ${plural(frames, "frame", "frames")}</b>: ` +
    `${parts.join(", ")}</p></section>`
  );
}
