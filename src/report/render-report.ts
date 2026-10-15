import { readFileSync } from "node:fs";
import type {
  ChangeBox,
  DiffResult,
  FileDiff,
  FrameCounts,
  FrameDiff,
  NodeChange,
  ThemeKey,
} from "../diff/model.js";
import {
  KINDS,
  type FrameRefs,
  type RenderedFrame,
  changeLines,
  changeListHtml,
  frameRefs,
  hasRefs,
  hasSemanticChange,
  statusLabel,
  summaryHtml,
} from "./changes.js";
import { esc, valueHtml } from "./html.js";

export { esc } from "./html.js";

export interface RenderReportOptions {
  /** Embed images as base64 data URIs instead of relative `images/...` references. */
  inline: boolean;
  /** Returns the bytes of an image given its relative path; undefined when missing. */
  imageReader?: (relPath: string) => Uint8Array | undefined;
}

const KIND_LABEL: Record<string, string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  moved: "moved",
  reordered: "reordered",
  pixel: "pixel difference",
};
const VIEW_LABELS = ["Side by side", "Swipe", "Onion skin", "Diff", "After only"];
const VIEW_TITLES = [
  "Before and After next to each other",
  "Drag the slider to wipe between Before and After",
  "Fade After over Before",
  "Changed pixels highlighted",
  "Only the After image",
];
const LEGEND: Record<string, string> = {
  added: "green: added (new in After)",
  removed: "red: removed (gone in After)",
  modified: "amber: modified (a property changed)",
  moved: "blue: moved (new parent)",
  reordered: "purple: reordered (same parent, new order)",
  pixel: "hatched grey: pixels changed with no matching node",
};
const VIEW_KEYS = ["side", "swipe", "onion", "diff", "head"];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function loadAsset(name: string): string {
  const candidates = [
    new URL(`./assets/${name}`, import.meta.url),
    new URL(`../../../src/report/assets/${name}`, import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return readFileSync(url, "utf8");
    } catch {
      // try the next location
    }
  }
  throw new Error(`report asset not found: ${name}`);
}

function num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function pngSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

function defaultReader(rel: string): Uint8Array | undefined {
  try {
    return readFileSync(rel);
  } catch {
    return undefined;
  }
}

function themeKeys(f: FrameDiff): ThemeKey[] {
  const keys = new Set<ThemeKey>([
    ...Object.keys(f.images ?? {}),
    ...Object.keys(f.pixelDiffRatio ?? {}),
  ]);
  if (keys.size === 0) keys.add("default");
  return [...keys].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

function maxRatio(f: FrameDiff): number | undefined {
  const vals = Object.values(f.pixelDiffRatio ?? {});
  return vals.length ? Math.max(...vals) : undefined;
}

function pct(r: number): string {
  const text = `${(r * 100).toFixed(2)}%`;
  return r > 0 && text === "0.00%" ? "<0.01%" : text;
}

const NO_PIXEL_CHANGE = "no visible pixel change";

function countBadges(c: FrameCounts): string {
  return KINDS.filter((k) => c[k] > 0)
    .map((k) => `<span class="badge k-${k}" data-kind="${k}" title="${k}">${c[k]}</span>`)
    .join("");
}

interface ImgRef {
  src: string;
  w: number;
  h: number;
}

class Renderer {
  private frameIndex = new Map<string, number>();
  private changed: RenderedFrame[] = [];

  constructor(
    private result: DiffResult,
    private opts: RenderReportOptions,
  ) {
    const reader = opts.imageReader;
    this.reader = reader ?? (opts.inline ? defaultReader : undefined);
    for (const file of result.files) {
      for (const frame of file.frames) {
        const refs = frameRefs(result, file, frame);
        if (frame.status === "unchanged" && frame.images === null && !hasRefs(refs)) continue;
        const index = this.changed.length;
        this.changed.push({ file, frame, index, refs });
        this.rendered.add(frame);
        for (const id of [frame.id, frame.baseId, frame.headId]) {
          if (id !== undefined) this.frameIndex.set(`${file.path}\u0000${id}`, index);
        }
      }
    }
  }

  private rendered = new Set<FrameDiff>();
  private reader: ((p: string) => Uint8Array | undefined) | undefined;

  private image(rel: string | undefined): ImgRef | undefined {
    if (!rel) return undefined;
    const bytes = this.reader?.(rel);
    if (this.opts.inline) {
      if (!bytes) return undefined;
      const mime = MIME[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";
      const b64 = Buffer.from(bytes).toString("base64");
      const size = pngSize(bytes);
      return { src: `data:${mime};base64,${b64}`, w: size?.w ?? 0, h: size?.h ?? 0 };
    }
    const size = bytes ? pngSize(bytes) : undefined;
    return { src: rel, w: size?.w ?? 0, h: size?.h ?? 0 };
  }

  private frameLink(file: string, frameId: string, label: string): string {
    const i = this.frameIndex.get(`${file}\u0000${frameId}`);
    return i === undefined
      ? `<span>${esc(label)}</span>`
      : `<a href="#frame-${i}">${esc(label)}</a>`;
  }

  private tip(box: ChangeBox, node: NodeChange | undefined): string {
    const kind = node?.change ?? box.kind;
    const name = node?.name ?? box.name ?? "";
    const id = node?.id ?? box.nodeId ?? "";
    let h = `<div class="tip" role="tooltip"><div><b>${esc(name)}</b>`;
    if (id) h += ` <code class="tip-id">${esc(id)}</code>`;
    h += `</div><div class="tip-kind">${esc(KIND_LABEL[kind] ?? kind)}</div>`;
    if (node?.from !== undefined || node?.to !== undefined) {
      h += `<div class="tip-move">${esc(node.from ?? "")} -&gt; ${esc(node.to ?? "")}</div>`;
    }
    if (node?.props?.length) {
      h += "<ul>";
      for (const p of node.props) {
        h += `<li><code>${esc(p.path)}</code>: ${valueHtml(p.old)} -&gt; ${valueHtml(p.new)}</li>`;
      }
      h += "</ul>";
    }
    return h + "</div>";
  }

  private boxes(frame: FrameDiff, side?: "base" | "head"): string {
    const byId = new Map(frame.nodes.map((n) => [n.id, n]));
    return frame.changeBoxes
      .filter((b) => side === undefined || b.side === side)
      .map((b) => {
        const node = b.nodeId === undefined ? undefined : byId.get(b.nodeId);
        const style = `left:${num(b.x)}px;top:${num(b.y)}px;width:${num(b.w)}px;height:${num(b.h)}px`;
        const label = `${KIND_LABEL[b.kind] ?? b.kind}: ${node?.name ?? b.name ?? b.nodeId ?? ""}`;
        return (
          `<div class="box k-${esc(b.kind)}" data-kind="${esc(b.kind)}" data-side="${b.side}"` +
          `${b.nodeId !== undefined ? ` data-node-id="${esc(b.nodeId)}"` : ""} tabindex="0" ` +
          `aria-label="${esc(label)}" style="${style}">${this.tip(b, node)}</div>`
        );
      })
      .join("");
  }

  private stage(img: ImgRef | undefined, boxes: string, cls = ""): string {
    if (!img) return `<div class="empty">No image available</div>`;
    return (
      `<div class="stage${cls}" data-w="${img.w}" data-h="${img.h}">` +
      `<img src="${esc(img.src)}" alt="">${boxes}</div>`
    );
  }

  private pane(label: string, side: string, stageHtml: string): string {
    return (
      `<div class="pane" data-side="${side}"><div class="label">${esc(label)}</div>` +
      `<div class="viewport">${stageHtml}</div></div>`
    );
  }

  private layered(frame: FrameDiff, base: ImgRef | undefined, head: ImgRef | undefined, kind: string): string {
    const boxes = this.boxes(frame);
    const baseImg = base ? `<img src="${esc(base.src)}" alt="">` : "";
    const headLayer = head ? `<div class="head-layer"><img src="${esc(head.src)}" alt=""></div>` : "";
    const ref = base ?? head;
    const stage = ref
      ? `<div class="stage" data-w="${ref.w}" data-h="${ref.h}">${baseImg}${headLayer}${boxes}</div>`
      : `<div class="empty">No image available</div>`;
    const control =
      kind === "swipe"
        ? `<label class="control swipe">Swipe <input type="range" min="0" max="100" value="50" aria-label="Swipe position"></label>`
        : `<label class="control onion">Opacity <input type="range" min="0" max="100" value="50" aria-label="Onion skin opacity"></label>`;
    return `${control}<div class="viewport">${stage}</div>`;
  }

  private themePane(frame: FrameDiff, key: ThemeKey): string {
    const entry = frame.images?.[key];
    const base = this.image(entry?.base);
    const head = this.image(entry?.head);
    const diff = this.image(entry?.diff);
    const hasBase = frame.status !== "added";
    const hasHead = frame.status !== "removed";
    let h = `<div class="tpane" data-tkey="${esc(key)}">`;
    const view = (name: string, inner: string) => `<div class="view" data-view="${name}">${inner}</div>`;
    const single = !(hasBase && hasHead);
    if (single) {
      const side = hasHead ? "head" : "base";
      const label = hasHead ? "Added frame: only in After" : "Removed frame: only in Before";
      const img = hasHead ? head : base;
      h += view(
        "side",
        `<div class="pair single">${this.pane(label, side, this.stage(img, this.boxes(frame, side)))}</div>`,
      );
    } else {
      h += view(
        "side",
        `<div class="pair">${this.pane("Before", "base", this.stage(base, this.boxes(frame, "base")))}` +
          `${this.pane("After", "head", this.stage(head, this.boxes(frame, "head")))}</div>`,
      );
      h += view("swipe", this.layered(frame, base, head, "swipe"));
      h += view("onion", this.layered(frame, base, head, "onion"));
      h += view("head", `<div class="pair single">${this.pane("After", "head", this.stage(head, this.boxes(frame)))}</div>`);
    }
    h += view(
      "diff",
      `<div class="pair single">${this.pane("Diff", "diff", this.stage(diff, this.boxes(frame)))}</div>`,
    );
    return h + "</div>";
  }

  /** The pixel ratio as a secondary detail; a zero ratio is explained, never shown as 0.00%. */
  private pixelNote(frame: FrameDiff, refs: FrameRefs): string {
    const mr = maxRatio(frame);
    if (mr === undefined) return "";
    if (mr > 0) return `<span class="ratio">pixels changed: ${esc(pct(mr))}</span>`;
    let why = "";
    if (hasSemanticChange(frame, refs)) {
      why = hasRefs(refs) ? " (change is not visible in this theme)" : " (e.g. reordered or same-looking value)";
    }
    return `<span class="ratio">${NO_PIXEL_CHANGE}${why}</span>`;
  }

  private frameSection({ file, frame, index, refs }: RenderedFrame): string {
    const keys = themeKeys(frame);
    const ratios = frame.pixelDiffRatio ?? {};
    let h = `<section class="frame" id="frame-${index}" data-frame="${index}" data-status="${esc(hasSemanticChange(frame, refs) && frame.status === "unchanged" ? "changed" : frame.status)}" data-tkey="${esc(keys[0])}">`;
    h += `<header><h3>${esc(frame.name)}</h3><span class="status">${esc(statusLabel(frame, refs))} · ${esc(file.path)}</span>`;
    h += countBadges(frame.counts);
    h += this.pixelNote(frame, refs);
    if (keys.length > 1) {
      h += `<select class="theme-select" aria-label="Theme">`;
      for (const k of keys) {
        const r = ratios[k];
        h += `<option value="${esc(k)}">${esc(k)}${r === undefined ? "" : r > 0 ? ` (${esc(pct(r))})` : " (no visible change)"}</option>`;
      }
      h += "</select>";
    }
    h += `<span class="group"><button type="button" data-action="zoom-out" title="Zoom out">−</button>` +
      `<button type="button" data-action="zoom-in" title="Zoom in">+</button>` +
      `<button type="button" data-action="reset" title="Reset zoom and pan">Reset</button></span></header>`;
    if (frame.missingBoxes.length > 0) {
      h += `<p class="missing-note">no layout box: ${frame.missingBoxes.map((id) => `<code>${esc(id)}</code>`).join(", ")}</p>`;
    }
    h += changeListHtml(changeLines(file, frame, refs));
    for (const k of keys) h += this.themePane(frame, k);
    return h + "</section>";
  }

  private sidebar(): string {
    let h = `<nav id="sidebar" aria-label="Changed frames">`;
    this.result.files.forEach((file, fi) => {
      h += `<h2>${esc(file.path)}</h2><ul data-file="${fi}">`;
      const unchanged: FrameDiff[] = [];
      for (const frame of file.frames) {
        if (!this.rendered.has(frame)) {
          unchanged.push(frame);
          continue;
        }
        const index = this.frameIndex.get(`${file.path}\u0000${frame.id}`) ?? 0;
        const keys = themeKeys(frame);
        const mr = maxRatio(frame);
        h += `<li data-frame="${index}"><a href="#frame-${index}">${esc(frame.name)}</a>${countBadges(frame.counts)}`;
        if (mr !== undefined) h += `<span class="ratio">${mr > 0 ? esc(pct(mr)) : NO_PIXEL_CHANGE}</span>`;
        if (keys.length > 1) {
          for (const k of keys) {
            if ((frame.pixelDiffRatio?.[k] ?? 0) > 0) h += `<span class="tbadge" title="theme changed">${esc(k)}</span>`;
          }
        }
        h += "</li>";
      }
      h += "</ul>";
      if (unchanged.length > 0) {
        h += `<details class="unchanged"><summary>${unchanged.length} unchanged frame${unchanged.length === 1 ? "" : "s"}</summary><ul>`;
        for (const f of unchanged) h += `<li>${esc(f.name)}</li>`;
        h += "</ul></details>";
      }
    });
    h += this.variableSection();
    return h + "</nav>";
  }

  private variableSection(): string {
    const { variables, themes } = this.result;
    if (variables.length === 0 && themes.length === 0) return "";
    const refs = (file: string, frames: { frameId: string }[]) =>
      frames.length
        ? ` <span class="affected">affects: ${frames.map((f) => this.frameLink(file, f.frameId, f.frameId)).join(", ")}</span>`
        : "";
    let h = `<section id="variables"><h2>Variables &amp; themes</h2><ul class="changes">`;
    for (const v of variables) {
      h += `<li data-kind="variable"><b>${esc(v.name)}</b> ${esc(v.change)}${v.theme ? ` (${esc(v.theme)})` : ""}`;
      if (v.change !== "added") h += ` ${valueHtml(v.old)}`;
      if (v.change === "modified") h += " -&gt;";
      if (v.change !== "removed") h += ` ${valueHtml(v.new)}`;
      h += `${refs(v.file, v.frames)}</li>`;
    }
    for (const t of themes) {
      h += `<li data-kind="theme">theme <b>${esc(t.name)}</b> ${esc(t.change)}${refs(t.file, t.frames)}</li>`;
    }
    return h + "</ul></section>";
  }

  render(): string {
    const { base, head } = this.result;
    const title = `Design diff ${base.ref} → ${head.ref}`;
    let h = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${esc(title)}</title><style>${loadAsset("report.css")}</style></head><body data-view="side">`;
    h += `<div id="topbar"><h1>${esc(title)}</h1><div id="views" class="group" role="group" aria-label="View mode">`;
    VIEW_KEYS.forEach((k, i) => {
      h += `<button type="button" data-view="${k}" title="${esc(VIEW_TITLES[i])}" aria-pressed="${i === 0}">${i + 1} ${VIEW_LABELS[i]}</button>`;
    });
    h += `</div><div class="group"><button type="button" id="pulse-toggle" aria-pressed="false">Pulse</button>` +
      `<button type="button" id="markers-toggle" aria-pressed="true">Markers</button>` +
      `<button type="button" id="theme-toggle">Theme</button><button type="button" id="help-toggle">?</button></div>`;
    h += `<div class="legend">`;
    for (const k of [...KINDS, "pixel"]) h += `<span><i class="k-${k}"></i> ${esc(LEGEND[k])}</span>`;
    h += `</div></div>${summaryHtml(this.result, this.changed)}<div id="layout">${this.sidebar()}<main>`;
    for (const entry of this.changed) h += this.frameSection(entry);
    if (this.changed.length === 0) h += `<p class="empty">No changed frames.</p>`;
    h += `</main></div>`;
    h += `<div id="help" hidden><div><h2>Keyboard</h2><p><kbd>j</kbd>/<kbd>k</kbd> or arrows: next/previous change<br>` +
      `<kbd>n</kbd>/<kbd>p</kbd>: next/previous frame<br><kbd>1</kbd>-<kbd>5</kbd>: view mode<br>` +
      `<kbd>m</kbd>: show/hide markers<br>` +
      `<kbd>?</kbd>: toggle this help, <kbd>Esc</kbd>: close</p></div></div>`;
    h += `<script>${loadAsset("report.js")}</script></body></html>\n`;
    return h;
  }
}

export function renderReport(result: DiffResult, opts: RenderReportOptions): string {
  return new Renderer(result, opts).render();
}
