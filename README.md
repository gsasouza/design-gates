# design-gates

Deterministic design review for `.pen` files: visual diff between versions and gates over the design JSON.

## Development

- `src/` — library (`index.ts`) and CLI (`cli.ts`) sources.
- `test/` — `*.test.ts` files run by `node:test`; helpers live in `test/helpers/` and are not tests.

Scripts:

- `npm run build` — clean `dist/` and compile with `tsc` (output in `dist/src`, `dist/test`).
- `npm test` — build, then run `dist/test/**/*.test.js`.

Dev dependencies (`typescript`, `@types/node`) are pinned to exact versions; the lockfile is `package-lock.json`.

## Fixtures and the pen loader

- `fixtures/` (repo root) holds sample `.pen` documents, e.g. `fixtures/minimal.pen`. Tests resolve it with `new URL('../../../fixtures/', import.meta.url)` from the compiled `dist/test/helpers/` (see `test/helpers/fixtures.ts`), never `process.cwd()`. Any bundled fonts must ship their licence text alongside (e.g. `fixtures/fonts/OFL.txt`).
- `src/pen/` is the `.pen` loader: `parsePen(text)` parses JSONC (comments and trailing commas allowed) into a typed `PenDocument`, and `loadPenFile(path)` reads a file. Invalid input throws an `Invalid .pen document` error. Types and loader are exported from `src/index.ts`.
