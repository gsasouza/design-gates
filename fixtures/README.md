# Diff fixtures

`base/` and `head/` hold the two sides of a design change. Every known edit is
isolated in its own file (or its own frame). `expected.json` is the
machine-readable form of the table below; `test/helpers/expected.ts` loads it.
The text uses the font pinned in `fonts/` (Inter).

| File (head path) | Frame id (head) | Edit | Expected change |
| --- | --- | --- | --- |
| `fill.pen` | `fill-frame` | `fill-rect` fill `#ff0000` -> `#00ff00` | `modified`, path `fill` |
| `text.pen` | `text-frame` | `text-title` content `Hello` -> `World` | `modified`, path `content` |
| `node-added.pen` | `added-frame` | `new-rect` added | `added` |
| `node-removed.pen` | `removed-frame` | `gone-rect` removed | `removed` |
| `node-moved.pen` | `moved-frame` | `mover` parent `group-a` -> `group-b` | `moved` |
| `node-reordered.pen` | `reorder-frame` | siblings `a,b,c` -> `b,c,a` (only `sib-a` is outside the longest increasing subsequence) | `reordered` on `sib-a` |
| `instance-override.pen` | `override-frame` | `descendants.label.fill` override on `ref` instance `btn-inst` | `modified`, path `descendants.label.fill` |
| `id-recreated.pen` | `recreated-new` (was `recreated-old`) | same frame, every id recreated | `none` (matched by name; zero added/removed/modified nodes) |
| `variable.pen` | `var-comp-frame`, `var-frame`, `var-ref-frame` | variable `bg` value in theme `mode=dark` `#000000` -> `#111111` | variable `modified` for each referencing frame; `var-none-frame` is not affected |
| `new/renamed.pen` | `renamed-frame` | renamed from `old/renamed.pen`, content identical | file `renamed`, change `none` |
| `added.pen` | `file-added-frame` | file only in head | file `added` |
| `removed.pen` | `file-removed-frame` | file only in base | file `removed` |
| `unchanged.pen` | `same-frame` | identical on both sides | file `unchanged`, change `none` |

## Variable-reference rule

A frame references a variable when any string value in its subtree (including
`descendants` overrides) equals `$<variableName>`, or when it contains an
instance (`ref`) of a reusable component that references it.

In `variable.pen`: `var-frame` references `$bg` directly, `var-comp-frame`
holds the reusable component that uses `$bg`, `var-ref-frame` only contains an
instance of that component, and `var-none-frame` does not reference it.

## `expected.json`

A list of `{file, oldPath?, fileStatus, frameId, nodeId?, change, path?,
matchedBy?, variable?, theme?}`. `fileStatus` is `added | removed | modified |
renamed | unchanged`; `change` is `added | removed | modified | moved |
reordered | none`; `matchedBy` is `id | name | structure`; `theme` is a theme
key (`axis=value` pairs sorted by axis, joined with `,`).
