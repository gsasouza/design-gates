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

## Rendering

- `src/render/renderer.ts` defines the `Renderer` interface (`renderFrame(doc, frameId, { scale, theme? })` → `{ png, width, height, nodeBoxes }`). Everything OpenPencil-specific lives in `src/render/openpencil.ts` (`createOpenPencilRenderer({ scale?, fontsDir? })`, default scale 1).
- Engine: [`@open-pencil/core`](https://github.com/open-pencil/open-pencil) (MIT), pinned to an exact version in `package.json`. It runs headless on CanvasKit WASM: no display, GPU or native build needed. Nothing depends on pen.dev, its MCP server or `@pen.dev/cli`.
- Flow: the `PenDocument` is deep-copied, the requested theme is pinned on the frame, `$variable` references are resolved to literals for the theme in effect (OpenPencil 0.16's importer ignores `theme` pins when resolving variables and only understands an axis literally named `theme`), then `parsePenFile` builds the scene graph and `headlessRenderNodes` renders the frame to PNG. The caller's document is never mutated and no temp files are written.
- Fonts: Inter Regular/Medium/SemiBold/Bold from `fixtures/fonts/` (licence: `fixtures/fonts/OFL.txt`) are registered in OpenPencil's font manager and online font providers are disabled, so rendering never falls back to system or network fonts.
- Layout info: OpenPencil exposes laid-out geometry per scene node (`graph.getAbsoluteBounds(id)`); node ids equal the `.pen` ids. `nodeBoxes` is that box for every node of the frame, relative to the frame origin and multiplied by `scale`. The `.pen` importer leaves auto-sized text at width 0 outside auto-layout containers, so those text nodes are sized with OpenPencil's own `estimateTextSize` (measured with the registered fonts) before rendering. Nodes that OpenPencil does not create (e.g. `prompt`) have no box.
- Gotcha: in `.pen`, frames default to a horizontal auto layout; fixtures that need absolute child positions set `"layout": "none"`.
- Limits: only variable references whose whole string value is `$name` are resolved; an instance's reusable component is themed by where the component lives, not where the instance sits.
