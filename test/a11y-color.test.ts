import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, contrastRatio, isLargeText, parseColor, relativeLuminance, withOpacity } from "../src/rules/a11y/color.js";

const c = (hex: string) => parseColor(hex)!;

test("parseColor reads short, long and alpha hex and rejects the rest", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#00000080"), { r: 0, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColor("#f008"), { r: 255, g: 0, b: 0, a: 136 / 255 });
  for (const bad of ["red", "#12", "#ggg", "$x", 5, undefined]) assert.equal(parseColor(bad), undefined);
});

test("relative luminance and contrast follow WCAG", () => {
  assert.equal(relativeLuminance(c("#000000")), 0);
  assert.equal(relativeLuminance(c("#FFFFFF")), 1);
  assert.equal(contrastRatio(c("#000000"), c("#FFFFFF")), 21);
  assert.equal(contrastRatio(c("#FFFFFF"), c("#FFFFFF")), 1);
  assert.equal(contrastRatio(c("#FFFFFF"), c("#000000")), 21);
  assert.equal(contrastRatio(c("#9CA3AF"), c("#FFFFFF")).toFixed(2), "2.54");
});

test("composite is source-over and withOpacity scales alpha", () => {
  assert.deepEqual(composite(c("#FF0000"), c("#0000FF")), c("#FF0000"));
  assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, c("#FFFFFF")), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  assert.equal(composite({ r: 9, g: 9, b: 9, a: 0 }, { r: 1, g: 1, b: 1, a: 0 }).a, 0);
  assert.equal(withOpacity(c("#00000080"), 0.5).a, (128 / 255) * 0.5);
  assert.equal(withOpacity(c("#000000"), 3).a, 1);
  assert.equal(withOpacity(c("#000000"), -1).a, 0);
});

test("large text is 24px+, or 18.66px+ when bold", () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(23.9, 400), false);
  assert.equal(isLargeText(18.66, 700), true);
  assert.equal(isLargeText(18.65, 700), false);
  assert.equal(isLargeText(18.66, 600), false);
});
