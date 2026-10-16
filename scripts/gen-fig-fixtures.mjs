// Regenerates fixtures/fig/<case>/{base,head}.fig with OpenPencil's own .fig writer.
// Run through `npm run fixtures:fig`, which builds first (the builders live in test/helpers).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FIG_FIXTURES, figFixturePath, writeFig } from "../dist/test/helpers/fig-fixtures.js";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const fixture of FIG_FIXTURES) {
  for (const side of ["base", "head"]) {
    const file = `${root}${figFixturePath(fixture.name, side)}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await writeFig(fixture.build(side)));
    process.stdout.write(`wrote ${figFixturePath(fixture.name, side)}\n`);
  }
}
