// Usage: npm run screenshot [-- <report.html> [<out.png>]]
// Opens a generated report with Playwright (Chromium) and saves docs/report.png.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const report = path.resolve(process.argv[2] ?? "design-diff/report.html");
const out = path.resolve(process.argv[3] ?? "docs/report.png");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed; run `npm install` and `npx playwright install chromium`.");
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  await page.goto(pathToFileURL(report).href);
  mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.error(`wrote ${out}`);
} finally {
  await browser.close();
}
