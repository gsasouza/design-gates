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
  assert.match(added.textContent!, /Added frame: head only/);
  const removed = doc.getElementById("frame-2")!;
  assert.match(removed.textContent!, /Removed frame: base only/);
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
  assert.match(html, /\.box\.k-pixel\{border-style:dashed\}/);
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
  assert.match(html, /\.pulse \.box\{animation:pulse \.7s ease-in-out 3\}/);
  assert.match(html, /prefers-reduced-motion:reduce\)\{\.pulse \.box\{animation:none\}/);
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
