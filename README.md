# design-gates

Deterministic design review for `.pen` files: visual diff between versions and gates over the design JSON.

## Development

- `src/` — library (`index.ts`) and CLI (`cli.ts`) sources.
- `test/` — `*.test.ts` files run by `node:test`; helpers live in `test/helpers/` and are not tests.

Scripts:

- `npm run build` — clean `dist/` and compile with `tsc` (output in `dist/src`, `dist/test`).
- `npm test` — build, then run `dist/test/**/*.test.js`.

CI: `.github/workflows/ci.yml` runs `npm ci` and `npm test` on Node 22 and 24 for every pull request and push to `main`.

Dev dependencies (`typescript`, `@types/node`) are pinned to exact versions; the lockfile is `package-lock.json`.

## Fixtures and the pen loader

- `fixtures/` (repo root) holds sample `.pen` documents, e.g. `fixtures/minimal.pen`. Tests resolve it with `new URL('../../../fixtures/', import.meta.url)` from the compiled `dist/test/helpers/` (see `test/helpers/fixtures.ts`), never `process.cwd()`. Any bundled fonts must ship their licence text alongside (e.g. `fixtures/fonts/OFL.txt`).
- `src/pen/` is the `.pen` loader: `parsePen(text)` parses JSONC (comments and trailing commas allowed) into a typed `PenDocument`, and `loadPenFile(path)` reads a file. Invalid input throws an `Invalid .pen document` error. Types and loader are exported from `src/index.ts`.

## Rendering

- `src/render/renderer.ts` defines the `Renderer` interface (`renderFrame(doc, frameId, { scale, theme? })` → `{ png, width, height, nodeBoxes }`). Everything OpenPencil-specific lives in `src/render/openpencil.ts` (`createOpenPencilRenderer({ scale?, fontsDir? })`, default scale 1).
- Engine: [`@open-pencil/core`](https://github.com/open-pencil/open-pencil) (MIT), pinned to an exact version in `package.json`. It runs headless on CanvasKit WASM: no display, GPU or native build needed. Nothing depends on pen.dev, its MCP server or `@pen.dev/cli`.
- Flow: the `PenDocument` is deep-copied, the requested theme is pinned on the frame, `$variable` references (including alias chains; cycles throw) are resolved to literals for the theme in effect (OpenPencil 0.16's importer ignores `theme` pins when resolving variables and only understands an axis literally named `theme`), then `parsePenFile` builds the scene graph and `headlessRenderNodes` renders the frame to PNG. The caller's document is never mutated and no temp files are written.
- Fonts: Inter Regular/Medium/SemiBold/Bold from `fixtures/fonts/` (licence: `fixtures/fonts/OFL.txt`) are registered in OpenPencil's font manager and online font providers are disabled, so rendering never falls back to system or network fonts.
- Layout info: OpenPencil exposes laid-out geometry per scene node (`graph.getAbsoluteBounds(id)`); node ids equal the `.pen` ids. `nodeBoxes` is that box for every node of the frame, relative to the frame origin and multiplied by `scale`. The `.pen` importer leaves auto-sized text at width 0 outside auto-layout containers, so those text nodes are sized with OpenPencil's own `estimateTextSize` (measured with the registered fonts) before rendering. Nodes that OpenPencil does not create (e.g. `prompt`) have no box.
- Gotcha: in `.pen`, frames default to a horizontal auto layout; fixtures that need absolute child positions set `"layout": "none"`.
- Limits: only variable references whose whole string value is `$name` are resolved; an instance's reusable component is themed by where the component lives, not where the instance sits.

Theme handling: `renderFrame` accepts `theme` (axis -> value, e.g. `{ mode: "dark" }`). `src/render/themes.ts` renders a deep copy of the document whose frame carries that `theme` (any `.pen` node may pin a theme, inherited by its subtree), so the caller's document is never mutated and no OpenPencil theme API is needed.

## Development notes: dependency pin

`@open-pencil/core` is pinned to `0.16.0` because `0.15.1` depends on `expr-eval@2.0.2` (CVE-2026-12866, CVSS 9.8, unmaintained since 2019, no fixed release) and this library parses untrusted `.pen` input. `0.16.0` has no `expr-eval`; `test/lockfile.test.ts` fails if it reappears in `package-lock.json`. The only catch is age: `0.16.0` and `twirlwind@0.4.1` reach 7 days old on 2026-10-21, after which `npm ci` works behind the operator's registry (cve-policy).

## Computing a semantic diff

```ts
import { computeSemanticDiff, serializeDiff } from "design-gates";

// base defaults to `git merge-base main HEAD`; head defaults to the working tree
// (uncommitted edits and untracked .pen files included).
const result = await computeSemanticDiff({ repo: ".", base: "main", head: "HEAD", paths: ["designs/**/*.pen"] });
const json: string = serializeDiff(result); // deterministic JSON
```

`computeSemanticDiffWithDocs` additionally returns the parsed base/head documents (`DiffDocs`, keyed by file path) for the visual diff. Git is only read (`--no-optional-locks`); the repo, index and HEAD are never modified. Pass `git` to inject a custom `GitReader`.

## Visual diff

`computeVisualDiff({ result, docs, renderer, outDir, scale, threshold })` renders every
`modified`/`added`/`removed` frame (plus frames listed by a variable or theme change) at base and
head with the injected `Renderer`, writes `images/<file-slug>/<frameId>[-<theme>]-{base,head,diff}.png`
under `outDir`, and fills `images`, `pixelDiffRatio` and `changeBoxes` (node boxes plus `pixel`
regions) per theme key. `file-slug` is the sanitized path plus the first 8 hex chars of its sha256.
Sizes that differ are padded top-left onto a transparent common canvas. Added/removed frames are
diffed against a blank canvas.

Every frame is rendered in the default theme and in each theme of a variable change that lists it.
The pixel threshold defaults to 0.1 (pixelmatch, anti-aliasing ignored), so tiny colour shifts
give a ratio of 0 unless a lower `threshold` is passed. A node the renderer
gives no box for is listed in `missingBoxes` instead of getting an invented box.
