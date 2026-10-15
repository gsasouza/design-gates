import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { renderReport } from "../src/index.js";
import type { DiffResult, FrameDiff } from "../src/index.js";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const reader = (p: string) => (p.endsWith(".png") ? png(4, 3) : undefined);

const counts = (o: Partial<FrameDiff["counts"]> = {}) => ({
  added: 0, removed: 0, modified: 0, moved: 0, reordered: 0, ...o,
});
const imgs = (p: string) => ({ base: `images/${p}-base.png`, head: `images/${p}-head.png`, diff: `images/${p}-diff.png` });

function fixture(name = "Login"): DiffResult {
  const login: FrameDiff = {
    id: "f1", name, baseId: "f1", headId: "f1", status: "modified", matchedBy: "id",
    counts: counts({ modified: 2, added: 1 }),
    nodes: [
      { id: "n1", name: "Button", type: "rectangle", change: "modified", props: [
        { path: "fill", old: "#ff0000", new: "#00ff00" },
        { path: "label", old: "red;background:url(https://x)", new: "rgb(1, 2, 3)" },
      ] },
      { id: "n2", name: "Icon", type: "frame", change: "added" },
    ],
    changeBoxes: [
      { x: 1, y: 2, w: 30, h: 20, kind: "modified", side: "base", nodeId: "n1", name: "Button" },
      { x: 1, y: 2, w: 30, h: 20, kind: "modified", side: "head", nodeId: "n1", name: "Button" },
      { x: 5, y: 5, w: 8, h: 8, kind: "added", side: "head", nodeId: "n2", name: "Icon" },
    ],
    missingBoxes: [],
    pixelDiffRatio: { default: 0.0123 },
    images: { default: imgs("f1") },
  };
  const added: FrameDiff = {
    id: "f2", name: "Signup", headId: "f2", status: "added", matchedBy: null,
    counts: counts({ added: 1 }), nodes: [{ id: "n3", name: "Root", type: "frame", change: "added" }],
    changeBoxes: [{ x: 0, y: 0, w: 10, h: 10, kind: "added", side: "head", nodeId: "n3" }],
    missingBoxes: [], pixelDiffRatio: null, images: { default: { head: "images/f2-head.png" } },
  };
  const removed: FrameDiff = {
    id: "f5", name: "Old", baseId: "f5", status: "removed", matchedBy: null,
    counts: counts({ removed: 1 }), nodes: [], changeBoxes: [], missingBoxes: [],
    pixelDiffRatio: null, images: { default: { base: "images/f5-base.png" } },
  };
  const themed: FrameDiff = {
    id: "f3", name: "Themed", baseId: "f3", headId: "f3", status: "modified", matchedBy: "id",
    counts: counts({ modified: 1 }),
    nodes: [{ id: "n4", name: "Card", type: "frame", change: "modified", props: [] }],
    changeBoxes: [{ x: 0, y: 0, w: 5, h: 5, kind: "pixel", side: "head" }],
    missingBoxes: ["ghost1", "ghost2"],
    pixelDiffRatio: { default: 0, "mode=dark": 0.5 },
    images: { default: imgs("t-d"), "mode=dark": imgs("t-k") },
  };
  const same: FrameDiff = {
    id: "f4", name: "Same", status: "unchanged", matchedBy: "id", counts: counts(), nodes: [],
    changeBoxes: [], missingBoxes: [], pixelDiffRatio: null, images: null,
  };
  return {
    schemaVersion: 1, base: { ref: "main", sha: "a" }, head: { ref: "feat", sha: "b" },
    files: [{ path: "a.pen", status: "modified", frames: [login, added, removed, themed, same] }],
    variables: [{ file: "a.pen", name: "primary", change: "modified", old: "#111111", new: "#222222", frames: [{ file: "a.pen", frameId: "f1" }] }],
    themes: [],
  };
}

function load(result = fixture(), inline = false) {
  const html = renderReport(result, { inline, imageReader: reader });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  return { dom, doc: dom.window.document, win: dom.window, html };
}
type Win = ReturnType<typeof load>["win"];
const key = (win: Win, k: string) =>
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
const input = (win: Win, el: Element, v: string) => {
  (el as HTMLInputElement).value = v;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
};

test("structure: sections, sidebar counts, unchanged collapsed, variables", () => {
  const { doc } = load();
  assert.equal(doc.querySelectorAll("section.frame").length, 4);
  const li = doc.querySelector('#sidebar li[data-frame="0"]')!;
  assert.equal(li.querySelector('.badge[data-kind="modified"]')!.textContent, "2");
  assert.equal(li.querySelector('.badge[data-kind="added"]')!.textContent, "1");
  assert.equal(li.querySelector('.badge[data-kind="removed"]'), null);
  assert.match(li.querySelector(".ratio")!.textContent!, /1\.23%/);
  const details = doc.querySelector("details.unchanged")!;
  assert.equal(details.hasAttribute("open"), false);
  assert.match(details.textContent!, /Same/);
  assert.equal(doc.querySelectorAll("section.frame").length, 4);
  const vars = doc.querySelector("#variables")!;
  assert.match(vars.textContent!, /primary/);
  assert.equal(vars.querySelector('a[href="#frame-0"]')!.textContent, "f1");
});

test("added/removed frames show only the existing side with a label", () => {
  const { doc } = load();
  const added = doc.getElementById("frame-1")!;
  assert.equal(added.querySelectorAll('.view[data-view="side"] .pane').length, 1);
  // Head/Base wording was replaced by the plain Before/After labels.
  assert.match(added.textContent!, /Added frame: only in After/);
  const removed = doc.getElementById("frame-2")!;
  assert.match(removed.textContent!, /Removed frame: only in Before/);
  assert.equal(removed.querySelector('.pane[data-side="head"]'), null);
});

test("swipe slider sets the clip on the head layer", () => {
  const { doc, win } = load();
  const view = doc.querySelector('#frame-0 .view[data-view="swipe"]')!;
  input(win, view.querySelector("input")!, "30");
  const layer = view.querySelector(".head-layer") as HTMLElement;
  assert.equal(layer.getAttribute("data-clip"), "30");
  assert.equal(layer.style.getPropertyValue("clip-path"), "inset(0 70% 0 0)");
});

test("onion slider sets head opacity", () => {
  const { doc, win } = load();
  const view = doc.querySelector('#frame-0 .view[data-view="onion"]')!;
  input(win, view.querySelector("input")!, "25");
  assert.equal((view.querySelector(".head-layer") as HTMLElement).style.opacity, "0.25");
});

test("view-mode switch shows the right view", () => {
  const { doc, win } = load();
  const visible = () =>
    [...doc.querySelectorAll("#frame-0 .view")].filter((v) => !(v as HTMLElement).hidden).map((v) => v.getAttribute("data-view"));
  assert.deepEqual(visible(), ["side"]);
  (doc.querySelector('#views button[data-view="onion"]') as HTMLElement).click();
  assert.deepEqual(visible(), ["onion"]);
  key(win, "4");
  assert.deepEqual(visible(), ["diff"]);
  key(win, "2");
  assert.deepEqual(visible(), ["swipe"]);
  assert.equal(doc.body.getAttribute("data-view"), "swipe");
  // single-sided frames fall back to their only view
  assert.equal([...doc.querySelectorAll("#frame-1 .view")].filter((v) => !(v as HTMLElement).hidden).length, 1);
});

test("zoom and pan on one side update the other", () => {
  const { doc, win } = load();
  const [baseVp, headVp] = [...doc.querySelectorAll('#frame-0 .view[data-view="side"] .viewport')];
  const stages = [...doc.querySelectorAll('#frame-0 .view[data-view="side"] .stage')] as HTMLElement[];
  const before = stages[1].style.transform;
  baseVp.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  assert.notEqual(stages[1].style.transform, before);
  assert.equal(stages[0].style.transform, stages[1].style.transform);
  assert.match(stages[1].style.transform, /scale\(1\.1\)/);
  const zoomed = stages[1].style.transform;
  headVp.dispatchEvent(new win.MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
  doc.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 40, clientY: 25, bubbles: true }));
  doc.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  assert.notEqual(stages[0].style.transform, zoomed);
  assert.equal(stages[0].style.transform, stages[1].style.transform);
  assert.match(stages[0].style.transform, /translate\(\d+(\.\d+)?px, 15px\)/);
  (doc.querySelector('#frame-0 [data-action="reset"]') as HTMLElement).click();
  assert.match(stages[0].style.transform, /translate\(0px, 0px\) scale\(1\)/);
  (doc.querySelector('#frame-0 [data-action="zoom-in"]') as HTMLElement).click();
  assert.match(stages[1].style.transform, /scale\(1\.25\)/);
});

test("boxes carry class and colour per change type", () => {
  const { doc, html } = load();
  const box = doc.querySelector('#frame-0 .pane[data-side="head"] .box.k-added')!;
  assert.equal(box.getAttribute("data-kind"), "added");
  assert.equal(doc.querySelectorAll('#frame-0 .pane[data-side="base"] .box').length, 1);
  assert.ok(doc.querySelector(".box.k-pixel"));
  assert.equal(doc.querySelectorAll(".legend i").length, 6);
  for (const [k, c] of [["added", "#16a34a"], ["removed", "#dc2626"], ["modified", "#d98e04"], ["moved", "#2563eb"], ["reordered", "#9333ea"]]) {
    assert.ok(html.includes(`--${k}:${c}`), k);
  }
  // Markers were bordered (dashed for pixel boxes); they are now borderless washes, so this
  // asserts the hatched pixel tint on the pseudo-element instead (see the CSS tests below).
  assert.match(html, /\.box\.k-pixel::before\{background:repeating-linear-gradient\(/);
});

test("hover and focus show a tooltip with props old -> new and swatches", () => {
  const { doc, win } = load();
  const box = doc.querySelector('#frame-0 .pane[data-side="head"] .box[data-node-id="n1"]') as HTMLElement;
  assert.equal(box.classList.contains("tip-open"), false);
  box.dispatchEvent(new win.MouseEvent("mouseenter"));
  assert.ok(box.classList.contains("tip-open"));
  box.dispatchEvent(new win.MouseEvent("mouseleave"));
  assert.equal(box.classList.contains("tip-open"), false);
  box.dispatchEvent(new win.FocusEvent("focus"));
  assert.ok(box.classList.contains("tip-open"));
  const tip = box.querySelector(".tip")!;
  assert.match(tip.textContent!, /Button/);
  assert.match(tip.textContent!, /n1/);
  assert.match(tip.textContent!, /modified/);
  assert.match(tip.textContent!, /fill: #ff0000 -> #00ff00/);
  const sw = [...tip.querySelectorAll(".swatch")].map((s) => (s as HTMLElement).getAttribute("style"));
  assert.deepEqual(sw, ["background:#ff0000", "background:#00ff00", "background:rgb(1, 2, 3)"]);
});

test("unsafe colour values are text only, never a swatch", () => {
  const { doc } = load();
  const li = [...doc.querySelectorAll('#frame-0 .box[data-node-id="n1"] .tip li')][1];
  assert.equal(li.querySelectorAll(".swatch").length, 1);
  assert.match(li.textContent!, /red;background:url\(https:\/\/x\)/);
  assert.doesNotMatch(li.innerHTML, /style="[^"]*url/);
});

test("keyboard j/k move across boxes and frames, n/p across frames", () => {
  const { doc, win } = load();
  const sel = () => doc.querySelector(".box.selected");
  assert.equal(sel(), null);
  key(win, "j");
  assert.equal(sel()!.getAttribute("data-node-id"), "n1");
  assert.equal(sel()!.getAttribute("data-side"), "base");
  key(win, "j");
  assert.equal(sel()!.getAttribute("data-side"), "head");
  key(win, "ArrowDown");
  assert.equal(sel()!.getAttribute("data-node-id"), "n2");
  key(win, "j");
  assert.equal(sel()!.getAttribute("data-node-id"), "n3");
  assert.ok(doc.getElementById("frame-1")!.classList.contains("current"));
  assert.equal(doc.querySelectorAll(".box.selected").length, 1);
  key(win, "k");
  assert.equal(sel()!.getAttribute("data-node-id"), "n2");
  assert.ok(doc.getElementById("frame-0")!.classList.contains("current"));
  key(win, "n");
  assert.ok(doc.getElementById("frame-1")!.classList.contains("current"));
  assert.equal(sel(), null);
  key(win, "n");
  assert.ok(doc.getElementById("frame-2")!.classList.contains("current"));
  key(win, "p");
  key(win, "p");
  assert.ok(doc.getElementById("frame-0")!.classList.contains("current"));
  assert.equal(doc.querySelectorAll("section.current").length, 1);
  key(win, "?");
  assert.equal(doc.getElementById("help")!.hasAttribute("hidden"), false);
  key(win, "Escape");
  assert.equal(doc.getElementById("help")!.hasAttribute("hidden"), true);
});

test("pulse toggle adds and removes the animation class", () => {
  const { doc } = load();
  const btn = doc.getElementById("pulse-toggle") as HTMLElement;
  assert.equal(doc.body.classList.contains("pulse"), false);
  btn.click();
  assert.ok(doc.body.classList.contains("pulse"));
  btn.click();
  assert.equal(doc.body.classList.contains("pulse"), false);
});

test("pulse animation is finite and disabled for reduced motion", () => {
  const { html } = load();
  // The animation moved from .box to its tint pseudo-element so the tooltip is not faded.
  assert.match(html, /\.pulse \.box::before\{animation:pulse \.7s ease-in-out 3\}/);
  assert.match(html, /prefers-reduced-motion:reduce\)\{\.pulse \.box::before\{animation:none\}/);
  assert.doesNotMatch(html, /animation:[^;}]*infinite/);
  assert.match(html, /@keyframes pulse\{[^@]*opacity/);
});

test("theme toggle switches data-theme", () => {
  const { doc } = load();
  const btn = doc.getElementById("theme-toggle") as HTMLElement;
  assert.equal(doc.documentElement.hasAttribute("data-theme"), false);
  btn.click();
  assert.equal(doc.documentElement.getAttribute("data-theme"), "dark");
  btn.click();
  assert.equal(doc.documentElement.getAttribute("data-theme"), "light");
});

test("per-frame theme switcher drives views, boxes, and sidebar", () => {
  const { doc, win } = load();
  const frame = doc.getElementById("frame-3")!;
  const sel = frame.querySelector("select.theme-select") as HTMLSelectElement;
  assert.deepEqual([...sel.options].map((o) => o.value), ["default", "mode=dark"]);
  assert.equal(doc.getElementById("frame-0")!.querySelector("select.theme-select"), null);
  const pane = (k: string) => frame.querySelector(`.tpane[data-tkey="${k}"]`) as HTMLElement;
  assert.equal(pane("default").hidden, false);
  assert.equal(pane("mode=dark").hidden, true);
  sel.value = "mode=dark";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal(pane("default").hidden, true);
  assert.equal(pane("mode=dark").hidden, false);
  assert.match(pane("mode=dark").innerHTML, /images\/t-k-base\.png/);
  assert.equal(pane("mode=dark").querySelectorAll(".view:not([hidden]) .box").length, 1);
  const li = doc.querySelector('#sidebar li[data-frame="3"]')!;
  assert.match(li.querySelector(".ratio")!.textContent!, /50\.00%/);
  assert.deepEqual([...li.querySelectorAll(".tbadge")].map((b) => b.textContent), ["mode=dark"]);
});

test("missing boxes are listed in a note", () => {
  const { doc } = load();
  const note = doc.querySelector("#frame-3 .missing-note")!;
  assert.match(note.textContent!, /no layout box/);
  assert.match(note.textContent!, /ghost1/);
  assert.match(note.textContent!, /ghost2/);
  assert.equal(doc.querySelector("#frame-0 .missing-note"), null);
});

test("inline: true yields data URIs, relative mode yields images/ paths; no http refs", () => {
  const inl = load(fixture(), true);
  assert.match(inl.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(inl.html, /src="images\//);
  assert.doesNotMatch(inl.html.replaceAll("url(https://x)", ""), /https?:\/\//);
  const imgSrcs = [...inl.doc.querySelectorAll("img")].map((i) => i.getAttribute("src")!);
  assert.ok(imgSrcs.length > 0);
  assert.ok(imgSrcs.every((s) => s.startsWith("data:")));
  assert.equal(inl.doc.querySelector('#frame-0 .stage')!.getAttribute("data-w"), "4");
  const rel = load();
  assert.match(rel.html, /src="images\/f1-base\.png"/);
  assert.doesNotMatch(rel.html, /data:image/);
});

test("output has no external URLs", () => {
  const clean = fixture();
  clean.files[0].frames[0].nodes[0].props = [];
  const html = renderReport(clean, { inline: false, imageReader: reader });
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(renderReport(clean, { inline: true, imageReader: reader }), /https?:\/\//);
});

test("node names are HTML-escaped", () => {
  const r = fixture("<script>alert(1)</script>");
  r.files[0].frames[0].nodes[0].name = "<script>alert(2)</script>";
  const { html, doc } = load(r);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(doc.querySelectorAll("script").length, 1);
  assert.equal(doc.querySelector("#frame-0 h3")!.textContent, "<script>alert(1)</script>");
});

test("rendering is deterministic", () => {
  const a = renderReport(fixture(), { inline: true, imageReader: reader });
  const b = renderReport(fixture(), { inline: true, imageReader: reader });
  assert.equal(a, b);
});

test("an unchanged frame rendered for a variable change gets a section and theme switcher", () => {
  const r = fixture();
  const frame: FrameDiff = {
    id: "v1", name: "Var", baseId: "v1", headId: "v1", status: "unchanged", matchedBy: "id",
    counts: counts(), nodes: [], changeBoxes: [], missingBoxes: [],
    pixelDiffRatio: { default: 0, "mode=dark": 0.25 },
    images: { default: imgs("v-d"), "mode=dark": imgs("v-k") },
  };
  r.files[0]!.frames.push(frame);
  const { doc } = load(r);
  const section = doc.querySelector('section.frame[data-status="unchanged"]')!;
  assert.ok(section);
  assert.ok(section.querySelector("select.theme-select"));
  assert.ok(doc.querySelector('#sidebar li a[href="#frame-' + section.getAttribute("data-frame") + '"]'));
  assert.match(doc.querySelector("details.unchanged")!.textContent!, /Same/);
});

function cssRules(html: string): { sel: string; body: string }[] {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
  return [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
}
const boxRules = (html: string) => cssRules(html).filter((r) => /\.box\b/.test(r.sel) && !/\.tip/.test(r.sel) && !/markers-off|pulse/.test(r.sel));
const alphaOf = (body: string) => Number(/color-mix\(in srgb,var\(--c\) (\d+)%/.exec(body)![1]);

test("markers are borderless translucent washes on ::before, with no ring in any state", () => {
  const { html } = load();
  const rules = boxRules(html);
  assert.ok(rules.length >= 5);
  for (const r of rules) {
    assert.doesNotMatch(r.body, /(^|;)\s*border\s*:\s*[^;]*\d+px/, r.sel);
    assert.doesNotMatch(r.body, /outline\s*:\s*(?!none)/, r.sel);
    assert.doesNotMatch(r.body, /box-shadow\s*:\s*(?!none)/, r.sel);
    assert.doesNotMatch(r.body, /mix-blend-mode/, r.sel);
  }
  for (const r of cssRules(html).filter((x) => /\.(box|tip)\b/.test(x.sel))) assert.doesNotMatch(r.body, /mix-blend-mode/, r.sel);
  const base = rules.find((r) => r.sel === ".box::before")!;
  assert.match(base.body, /background:color-mix\(in srgb,var\(--c\) 30%,transparent\)/);
  assert.match(base.body, /pointer-events:none/);
  assert.match(base.body, /inset:0/);
  const pixel = rules.find((r) => r.sel === ".box.k-pixel::before")!;
  assert.match(pixel.body, /repeating-linear-gradient/);
  assert.equal(rules.find((r) => r.sel === ".box")!.body.includes("background:none"), true);
});

test("a selected or focused marker has a stronger tint than a plain one", () => {
  const { html } = load();
  const rules = boxRules(html);
  const base = alphaOf(rules.find((r) => r.sel === ".box::before")!.body);
  const sel = rules.find((r) => r.sel === ".box.selected::before,.box:focus::before")!;
  assert.ok(alphaOf(sel.body) > base);
  assert.ok(alphaOf(sel.body) >= 45 && alphaOf(sel.body) <= 50);
});

test("the pulse keyframes animate the tint pseudo-element, not the box", () => {
  const { html } = load();
  assert.ok(cssRules(html).some((r) => r.sel === ".pulse .box::before"));
  assert.ok(!cssRules(html).some((r) => r.sel === ".pulse .box"));
});

test("legend swatches are filled translucent tiles", () => {
  const { html } = load();
  const r = cssRules(html).find((x) => x.sel === ".legend i,.swatch")!;
  assert.match(r.body, /background:color-mix\(in srgb,var\(--c,var\(--pixel\)\) 30%,transparent\)/);
  assert.match(r.body, /border:0/);
});

test("m and the Markers button toggle all markers; j ignores hidden markers", () => {
  const { doc, win } = load();
  const btn = doc.getElementById("markers-toggle") as HTMLElement;
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.equal(doc.body.classList.contains("markers-off"), false);
  key(win, "m");
  assert.equal(doc.body.classList.contains("markers-off"), true);
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  key(win, "j");
  assert.equal(doc.querySelector(".box.selected"), null);
  btn.click();
  assert.equal(doc.body.classList.contains("markers-off"), false);
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  key(win, "j");
  assert.ok(doc.querySelector(".box.selected"));
  key(win, "m");
  assert.equal(doc.querySelector(".box.selected"), null, "hiding markers clears the selection");
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true }));
  assert.equal(doc.body.classList.contains("markers-off"), true, "Ctrl+m is ignored");
  assert.match(doc.getElementById("help")!.textContent!, /markers/);
});

function fitDom(availW: number, innerH: number, w: number, h: number) {
  const { doc, win } = load();
  // report.js already ran during construction (jsdom has no layout), so mock sizes and resize.
  Object.defineProperty(win.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => availW });
  Object.defineProperty(win, "innerHeight", { configurable: true, value: innerH });
  for (const st of doc.querySelectorAll("#frame-0 .stage")) {
    st.setAttribute("data-w", String(w));
    st.setAttribute("data-h", String(h));
  }
  win.dispatchEvent(new win.Event("resize"));
  const stages = [...doc.querySelectorAll('#frame-0 .view[data-view="side"] .stage')] as HTMLElement[];
  const vps = [...doc.querySelectorAll('#frame-0 .view[data-view="side"] .viewport')] as HTMLElement[];
  const scale = () => Number(/scale\(([\d.]+)\)/.exec(stages[0]!.style.transform)![1]);
  return { doc, win, stages, vps, scale };
}

test("zoom-to-fit: a large frame fits the width/height box and Reset returns to it", () => {
  const { doc, stages, vps, scale } = fitDom(500, 1000, 2000, 3000);
  const expected = Math.min(500 / 2000, (1000 * 0.7) / 3000);
  assert.ok(Math.abs(scale() - expected) < 1e-9);
  assert.equal(stages[0]!.style.transform, stages[1]!.style.transform);
  for (const vp of vps) assert.equal(vp.style.height, `${Math.ceil(3000 * expected)}px`);
  (doc.querySelector('#frame-0 [data-action="zoom-in"]') as HTMLElement).click();
  assert.ok(Math.abs(scale() - expected * 1.25) < 1e-9);
  (doc.querySelector('#frame-0 [data-action="reset"]') as HTMLElement).click();
  assert.ok(Math.abs(scale() - expected) < 1e-9);
  assert.match(stages[0]!.style.transform, /translate\(0px, 0px\)/);
});

test("zoom-to-fit: a small frame scales up, capped at 400%, and the viewport hugs it", () => {
  const a = fitDom(400, 1000, 100, 50);
  assert.ok(Math.abs(a.scale() - 4) < 1e-9, "capped at 4");
  for (const vp of a.vps) assert.equal(vp.style.height, `${Math.ceil(50 * 4)}px`);
  const b = fitDom(300, 1000, 100, 50);
  assert.ok(Math.abs(b.scale() - 3) < 1e-9, "scaled up but not capped");
  for (const vp of b.vps) assert.equal(vp.style.height, `${Math.ceil(50 * 3)}px`);
});

test("legend text keeps WCAG AA contrast (4.5:1) against the panel in both themes", () => {
  const html = renderReport(fixture(), { inline: false, imageReader: reader });
  const rules = cssRules(html);
  const lum = (h: string) => {
    const hex = h.length === 4 ? "#" + [...h.slice(1)].map((x) => x + x).join("") : h;
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  assert.match(rules.find((r) => r.sel === ".legend")!.body, /color:var\(--muted\)/);
  const themes = rules.filter((r) => /--muted:#/.test(r.body) && /--panel:#/.test(r.body));
  assert.ok(themes.length >= 3, "light + two dark theme blocks");
  for (const t of themes) {
    const muted = /--muted:(#[0-9a-f]{3,6})/i.exec(t.body)![1]!;
    const panel = /--panel:(#[0-9a-f]{3,6})/i.exec(t.body)![1]!;
    assert.ok(ratio(muted, panel) >= 4.5, `${t.sel}: ${muted} on ${panel}`);
  }
});

// ---- summary, change list, labels (plain-language report) ----

type Node = FrameDiff["nodes"][number];
const frameOf = (o: Partial<FrameDiff> & { id: string }): FrameDiff => ({
  name: o.id, baseId: o.id, headId: o.id, status: "modified", matchedBy: "id", counts: counts(),
  nodes: [], changeBoxes: [], missingBoxes: [], pixelDiffRatio: { default: 0.01 },
  images: { default: imgs(o.id) }, ...o,
});
const resultOf = (frames: FrameDiff[], extra: Partial<DiffResult> = {}): DiffResult => ({
  schemaVersion: 1, base: { ref: "main", sha: "a" }, head: { ref: "feat", sha: "b" },
  files: [{ path: "a.pen", status: "modified", frames }], variables: [], themes: [], ...extra,
});
const node = (o: Partial<Node> & { id: string; change: Node["change"] }): Node => ({ name: o.id, type: "rectangle", ...o });
const linesOf = (r: DiffResult, i = 0) =>
  [...load(r).doc.querySelectorAll(`#frame-${i} .change-list li`)].map((l) => l.textContent);

test("summary: totals, per-kind links to the first frame with that kind, variables", () => {
  const { doc } = load();
  const s = doc.getElementById("summary")!;
  assert.equal(
    s.textContent,
    "9 changes in 4 frames: 3 added, 2 removed, 3 modified, 1 variable changed",
  );
  const href = (k: string) => s.querySelector(`a[data-kind="${k}"]`)?.getAttribute("href");
  assert.equal(href("added"), "#frame-0");
  assert.equal(href("removed"), "#frame-2");
  assert.equal(href("modified"), "#frame-0");
  assert.equal(href("moved"), undefined);
  assert.equal(href("reordered"), undefined);
  assert.ok(s.compareDocumentPosition(doc.getElementById("frame-0")!) & 4, "summary precedes the frames");
});

test("summary: a result that only adds a frame, and one with nothing", () => {
  const added = frameOf({ id: "new", name: "Newbie", baseId: undefined, status: "added", images: null, pixelDiffRatio: null });
  const { doc } = load(resultOf([added]));
  assert.equal(doc.getElementById("summary")!.textContent, "1 change in 1 frame: 1 added");
  assert.equal(doc.querySelector('#summary a[data-kind="added"]')!.getAttribute("href"), "#frame-0");
  assert.deepEqual(linesOf(resultOf([added])), ["Newbie frame added"]);
  const none = load(resultOf([frameOf({ id: "z", status: "unchanged", images: null })]));
  assert.equal(none.doc.getElementById("summary")!.textContent, "No changes");
});

test("change list: added and removed nodes", () => {
  const f = frameOf({ id: "f", nodes: [node({ id: "n", name: "Card", change: "added" }), node({ id: "m", name: "Gone", change: "removed" })] });
  assert.deepEqual(linesOf(resultOf([f])), ["Card added", "Gone removed"]);
  const li = load(resultOf([f])).doc.querySelector("#frame-0 .change-list li")!;
  assert.equal(li.getAttribute("data-node-id"), "n");
  assert.equal(li.getAttribute("data-kind"), "added");
});

test("change list: colour and text props, strings quoted", () => {
  const f = frameOf({ id: "f", nodes: [
    node({ id: "r", name: "Button", change: "modified", props: [{ path: "fill", old: "#FF0000", new: "#00FF00" }] }),
    node({ id: "t", name: "Title", type: "text", change: "modified", props: [{ path: "text", old: "Hello", new: "Olá" }, { path: "size", old: 12, new: 14 }] }),
  ] });
  const r = resultOf([f]);
  assert.deepEqual(linesOf(r), [
    "Button / fill: #FF0000 -> #00FF00",
    "Title / text: 'Hello' -> 'Olá'",
    "Title / size: 12 -> 14",
  ]);
  assert.equal(load(r).doc.querySelectorAll("#frame-0 .change-list .swatch").length, 2);
});

test("change list: x and y combine into one moved line; non-numeric falls back", () => {
  const mk = (props: { path: string; old: unknown; new: unknown }[]) =>
    resultOf([frameOf({ id: "f", nodes: [node({ id: "c", name: "Card", change: "modified", props })] })]);
  assert.deepEqual(linesOf(mk([{ path: "x", old: 10, new: 34 }, { path: "y", old: 20, new: 28 }])), ["Card moved 24px right, 8px down"]);
  assert.deepEqual(linesOf(mk([{ path: "x", old: 10, new: 4.5 }, { path: "y", old: 20, new: 20 }])), ["Card moved 5.5px left"]);
  assert.deepEqual(linesOf(mk([{ path: "y", old: 20, new: 12 }])), ["Card moved 8px up"]);
  assert.deepEqual(linesOf(mk([{ path: "x", old: "fit", new: 3 }])), ["Card / x: 'fit' -> 3"]);
});

test("change list: moved to another parent resolves names, falls back to the raw id", () => {
  const header = frameOf({ id: "hdr", name: "Header", status: "unchanged", images: null });
  const f = frameOf({ id: "f", name: "Page", nodes: [
    node({ id: "c1", name: "Card", change: "moved", from: "hdr", to: "f" }),
    node({ id: "c2", name: "Chip", change: "moved", from: "p-unknown", to: "ftr" }),
    node({ id: "ftr", name: "Footer", type: "frame", change: "added" }),
  ] });
  assert.deepEqual(linesOf(resultOf([f, header])), [
    "Card moved from Header to Page",
    "Chip moved from p-unknown to Footer",
    "Footer added",
  ]);
});

test("change list: reordered, and unnamed nodes fall back to the id (instance override)", () => {
  const f = frameOf({ id: "f", nodes: [
    node({ id: "sib-a", name: "Card", change: "reordered" }),
    node({ id: "btn-inst", name: "", type: "ref", change: "modified", props: [{ path: "descendants.label.fill", old: "#112233", new: "#445566" }] }),
  ] });
  assert.deepEqual(linesOf(resultOf([f])), [
    "Card reordered",
    "btn-inst / descendants.label.fill: #112233 -> #445566",
  ]);
});

test("change list: variable and theme lines", () => {
  const f = frameOf({ id: "vf", name: "Var" });
  const ref = [{ file: "a.pen", frameId: "vf" }];
  const r = resultOf([f], {
    variables: [
      { file: "a.pen", name: "color.bg", change: "modified", theme: "dark", old: "#000000", new: "#444444", frames: ref },
      { file: "a.pen", name: "gap", change: "added", new: 4, frames: ref },
      { file: "a.pen", name: "old", change: "removed", old: "x", frames: ref },
      { file: "a.pen", name: "other", change: "modified", old: 1, new: 2, frames: [{ file: "b.pen", frameId: "vf" }] },
    ],
    themes: [{ file: "a.pen", name: "mode", change: "added", frames: ref }],
  });
  assert.deepEqual(linesOf(r), [
    "variable color.bg (dark): #000000 -> #444444",
    "variable gap added: 4",
    "variable old removed: 'x'",
    "theme mode added",
  ]);
  const { doc } = load(r);
  assert.equal(doc.getElementById("summary")!.textContent, "5 changes in 1 frame: 4 variables changed, 1 theme changed");
});

test("clicking a change-list line selects the matching marker and makes the frame current", () => {
  const { doc } = load();
  const line = doc.querySelector('#frame-0 .change-list li[data-node-id="n2"] button') as HTMLElement;
  line.click();
  const sel = doc.querySelectorAll(".box.selected");
  assert.equal(sel.length, 1);
  assert.equal(sel[0]!.getAttribute("data-node-id"), "n2");
  assert.ok(doc.getElementById("frame-0")!.classList.contains("current"));
  // a line with no marker (variable line) does nothing harmful
  (doc.querySelector('#frame-0 .change-list li[data-kind="variable"] button') as HTMLElement).click();
  assert.equal(doc.querySelectorAll(".box.selected").length, 0);
});

test("clicking a line while markers are hidden turns them back on, then selects", () => {
  const { doc, win } = load();
  key(win, "m");
  const btn = doc.getElementById("markers-toggle")!;
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  (doc.querySelector('#frame-0 .change-list li[data-node-id="n1"] button') as HTMLElement).click();
  assert.equal(doc.body.classList.contains("markers-off"), false);
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.equal(doc.querySelector(".box.selected")!.getAttribute("data-node-id"), "n1");
});

test("a status-unchanged frame affected by a variable is labelled as changed, not unchanged", () => {
  const same = frameOf({ id: "vf", name: "Var", status: "unchanged", images: null, pixelDiffRatio: null });
  const r = resultOf([same, frameOf({ id: "quiet", name: "Quiet", status: "unchanged", images: null, pixelDiffRatio: null })], {
    variables: [
      { file: "a.pen", name: "color.bg", change: "modified", old: "#000000", new: "#111111", frames: [{ file: "a.pen", frameId: "vf" }] },
      { file: "a.pen", name: "color.fg", change: "modified", old: "#ffffff", new: "#eeeeee", frames: [{ file: "a.pen", frameId: "vf" }] },
    ],
  });
  const { doc } = load(r);
  const sec = doc.getElementById("frame-0")!;
  assert.match(sec.querySelector(".status")!.textContent!, /changed via variable color\.bg, color\.fg/);
  assert.doesNotMatch(sec.textContent!, /unchanged/);
  assert.match(sec.textContent!, /No image available/);
  const un = doc.querySelector("details.unchanged")!.textContent!;
  assert.match(un, /Quiet/);
  assert.doesNotMatch(un, /Var/);
  const themed = frameOf({ id: "tf", name: "T", status: "unchanged" });
  const t = load(resultOf([themed], { themes: [{ file: "a.pen", name: "dark", change: "added", frames: [{ file: "a.pen", frameId: "tf" }] }] }));
  assert.match(t.doc.querySelector("#frame-0 .status")!.textContent!, /changed via theme dark/);
});

test("no bare 0.00%: zero ratios say no visible pixel change, with a reason", () => {
  const varFrame = frameOf({ id: "vf", status: "unchanged", pixelDiffRatio: { default: 0 } });
  const reorder = frameOf({ id: "ro", nodes: [node({ id: "a", change: "reordered" })], pixelDiffRatio: { default: 0 } });
  const tiny = frameOf({ id: "ti", nodes: [node({ id: "b", change: "added" })], pixelDiffRatio: { default: 0.000001 } });
  const r = resultOf([varFrame, reorder, tiny], {
    variables: [{ file: "a.pen", name: "v", change: "added", new: 1, frames: [{ file: "a.pen", frameId: "vf" }] }],
  });
  const { doc, html } = load(r);
  assert.match(doc.querySelector("#frame-0 .ratio")!.textContent!, /^no visible pixel change \(change is not visible in this theme\)$/);
  assert.match(doc.querySelector("#frame-1 .ratio")!.textContent!, /^no visible pixel change \(e\.g\. reordered or same-looking value\)$/);
  assert.equal(doc.querySelector("#frame-2 .ratio")!.textContent, "pixels changed: <0.01%");
  assert.doesNotMatch(html, /0\.00%/);
  assert.doesNotMatch(doc.getElementById("sidebar")!.textContent!, /0\.00%/);
  assert.equal(doc.querySelector('#sidebar li[data-frame="0"] .ratio')!.textContent, "no visible pixel change");
  // headline is the semantic change, with the pixel ratio as a muted secondary detail
  assert.equal(load().doc.querySelector("#frame-0 .ratio")!.textContent, "pixels changed: 1.23%");
});

test("theme options with a zero ratio read 'no visible change'", () => {
  const opts = [...load().doc.querySelectorAll("#frame-3 select option")].map((o) => o.textContent);
  assert.deepEqual(opts, ["default (no visible change)", "mode=dark (50.00%)"]);
});

test("labels: Before/After everywhere, titles on view buttons, worded legend, normal-case headers", () => {
  const { doc, html } = load();
  const visible = doc.body.cloneNode(true) as HTMLElement;
  visible.querySelectorAll("script").forEach((x) => x.remove());
  assert.doesNotMatch(visible.textContent!, /\b(Base|Head|head only|base only)\b/);
  assert.deepEqual([...doc.querySelectorAll("#frame-0 .view[data-view=side] .label")].map((l) => l.textContent), ["Before", "After"]);
  assert.equal(doc.querySelector('#views button[data-view="head"]')!.textContent, "5 After only");
  assert.deepEqual([...doc.querySelectorAll("#views button")].map((b) => b.getAttribute("data-view")), ["side", "swipe", "onion", "diff", "head"]);
  const titles = (v: string) => doc.querySelector(`#views button[data-view="${v}"]`)!.getAttribute("title");
  assert.equal(titles("swipe"), "Drag the slider to wipe between Before and After");
  assert.equal(titles("onion"), "Fade After over Before");
  assert.equal(titles("diff"), "Changed pixels highlighted");
  assert.ok(titles("side") && titles("head"));
  const legend = doc.querySelector(".legend")!.textContent!;
  for (const t of ["green: added (new in After)", "red: removed (gone in After)", "amber: modified (a property changed)",
    "blue: moved (new parent)", "purple: reordered (same parent, new order)", "hatched grey: pixels changed with no matching node"]) {
    assert.ok(legend.includes(t), t);
  }
  const h2 = cssRules(html).find((r) => r.sel === "#sidebar h2")!;
  assert.doesNotMatch(h2.body, /text-transform/);
});

test("summary and change-list text meet WCAG AA on the panel in every theme", () => {
  const html = renderReport(fixture(), { inline: false, imageReader: reader });
  const rules = cssRules(html);
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const sel of ["#summary", ".change-list"]) assert.match(rules.find((r) => r.sel === sel)!.body, /color:var\(--fg\)/);
  assert.match(rules.find((r) => r.sel === "#summary a")!.body, /color:var\(--accent\)/);
  assert.match(rules.find((r) => r.sel === "#summary")!.body, /background:var\(--panel\)/);
  for (const t of rules.filter((r) => /--muted:#/.test(r.body) && /--panel:#/.test(r.body))) {
    const get = (n: string) => {
      const h = new RegExp(`--${n}:(#[0-9a-f]{3,6})`, "i").exec(t.body)![1]!;
      return h.length === 4 ? "#" + [...h.slice(1)].map((x) => x + x).join("") : h;
    };
    for (const n of ["fg", "muted", "accent"]) assert.ok(ratio(get(n), get("panel")) >= 4.5, `${t.sel} ${n}`);
  }
});

test("change-list lines are keyboard-activatable buttons and user text is escaped", () => {
  const f = frameOf({ id: "f", nodes: [node({ id: "n", name: "<img src=x>", change: "added" })] });
  const { doc, html } = load(resultOf([f]));
  assert.ok(doc.querySelector('#frame-0 .change-list li button[type="button"]'));
  assert.equal(doc.querySelector("#frame-0 .change-list img"), null);
  assert.ok(html.includes("&lt;img src=x&gt; added"));
});
