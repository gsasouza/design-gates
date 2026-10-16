---
name: design-cli
description: Use when saving, comparing, restoring or exploring versions of .pen design files with the design CLI.
---

# design CLI: versions of .pen design files

Use this when the user wants to save a version of their designs, see what changed, go back to an earlier version of a file, or try an alternative without risking the original.

## Mental model

- A **version** is a save. `#1` is the newest, `#2` the one before it, and so on.
- An **exploration** is a separate line of experiments. `main` is the original line.
- Everything stays on this computer. History is never rewritten or deleted.
- A version can be written as `#n`, a version id (4 or more characters), an exploration name, or `main`.

## Agent rules

- Always pass `--json` and parse the result. Use `--repo <folder>` to point at the design folder (default: the current folder).
- Branch on the exit code:
  - `0` ok, including "nothing to save".
  - `1` refused to protect work, or saving was refused (by signing or a hook), or an unexpected failure (message starts with `design: `). Also "This folder doesn't have versions yet": run `design init`. Also "inside another project's history".
  - `2` usage error, or an unknown or ambiguous version.
- With `--json`, errors print `{"error": "...", "code": n}` on stdout (and the message on stderr).
- Never call git directly in a design folder. The CLI's safety rules exist for a reason: no reset, rebase, push, force or amend.
- Run `design status --json` before restore, switch or explore.
- On an "unsaved changes" refusal, ask the user, or run `design save -m "..."`. Only `restore` also accepts `--save-first`. For `explore` and `switch` the only fixes are `design save -m "..."` or asking the user; adding `--save-first` there exits 2. Never discard work.

## Commands

Samples are real `--json` output, trimmed (ids and dates shortened).

### init
`design init --json` (safe to run again; existing designs become the first version)
```json
{"createdRepo":true,"gitignoreUpdated":true,"identitySet":["user.name","user.email"],
 "saved":{"saved":true,"version":{"sha":"e7dc676…","shortId":"e7dc676"},"message":"First version","files":[{"path":"home.pen","state":"new"}],"summary":"…"},
 "changed":true,"summary":"Started tracking versions in this folder. …"}
```

### status
`design status --json`
```json
{"exploration":"main","files":[{"path":"home.pen","state":"changed"}],"clean":false,"summary":"1 unsaved change on exploration \"main\": home.pen (changed)."}
```
Clean: `"files":[],"clean":true`.

### save
`design save -m "Wider frame" --json`
```json
{"saved":true,"version":{"sha":"b7d3594…","shortId":"b7d3594"},"message":"Wider frame","files":[{"path":"home.pen","state":"changed"}],"summary":"Saved a new version (b7d3594): Wider frame. 1 file included."}
```
Nothing changed is not an error (exit 0): `{"saved":false,"version":null,"message":null,"files":[],"summary":"Nothing to save: no design changes since the last version."}`. Without `-m` the note is "Saved <date>".

### history
`design history [file] --limit 2 --json` (newest first; `file` keeps only versions that changed it; `--limit` is a whole number)
```json
{"exploration":"main","file":"home.pen","versions":[{"number":2,"sha":"b7d3594…","shortId":"b7d3594","date":"2026-10-16T00:36:41+00:00","message":"Wider frame","files":["home.pen"]}],"summary":"1 saved version for home.pen, newest first."}
```

### compare
`design compare [from] [to] [paths...] [--out <folder>] [--open] --json`
```json
{"files":1,"frames":2,"changes":1,"reportPath":"/…/design-diff/report.html","from":{"sha":"4bfa9fe…","shortId":"4bfa9fe","label":"version #1 (4bfa9fe) \"Add about page\""},"to":null,"summary":"1 change in 2 frames — report: /…/design-diff/report.html"}
```
- Defaults: `from` is `#1`, `to` is your unsaved changes (`"to":null`).
- `from`/`to` can be `#n`, ids, exploration names or `main`; trailing words are design files to limit the report to.
- Words after `compare` are read left to right: a word is a version while no file has been seen, fewer than two versions are taken, and it is a known version reference. The first word that is not a version starts the files, and everything after it is a file too.
- A mistyped `#n` is an error, not a file name. An ambiguous word is an error (exit 2).
- `--out <folder>` sets the report folder (default `design-diff` in the design folder). It is resolved against the current working folder, not `--repo`: with `--repo`, pass an absolute path or leave it out.
- `--open` opens the report in the system viewer when it is ready.

### restore
`design restore <version> [paths...] [--save-first] --json`
```json
{"restored":true,"version":{"sha":"b7d3594…","shortId":"b7d3594","label":"version #2 (b7d3594) \"Wider frame\""},"files":[{"path":"home.pen","state":"changed"}],"savedFirst":null,"summary":"Brought back #2 as 1 unsaved change. Nothing was lost: run design save to keep it as a new version."}
```
With `--save-first`, `savedFirst` holds the save result (same shape as `save`) and the summary adds "Your earlier changes were saved first (…)". If the files already match: `"restored":false,"files":[]`.
Refusal when there are unsaved changes (exit 1):
```json
{"error":"You have 1 unsaved change, and restoring would mix them with the old version. Run design save first, or use --save-first.","code":1}
```
The restored files show up as unsaved changes; run `design save -m ...` to keep them as a new version.

### explore
`design explore --json` lists explorations; `design explore bolder --json` starts one from the current version and moves to it.
```json
{"created":true,"exploration":"bolder","explorations":[{"name":"bolder","current":true},{"name":"main","current":false}],"summary":"Started exploration \"bolder\" from the current version and switched to it."}
```
Refused (exit 1) with unsaved changes: "You have 1 unsaved change, so you can't start an exploration yet. Run design save first."

### switch
`design switch <name|main> --json`
```json
{"exploration":"main","switched":true,"summary":"Switched to exploration \"main\"."}
```
Already there: `"switched":false`. Unknown name: exit 2, "There is no exploration called …". Unsaved changes: exit 1, "Run design save first."

## Common workflows

- **What changed since my last save:** `design compare --json`, then read `reportPath` (report.html in the report folder) or open it with `--open`.
- **Go back to yesterday's version of one file:** `design history <file> --json` to find the version, `design status --json`, then `design restore <version> <file> --json`.
- **Try an alternative layout safely:** `design status --json`; `design explore <name>`; edit; `design save -m "..."`; `design compare main --json`; `design switch main`.
- **What did I change in this file over time:** `design history <file> --json`.

## Pitfalls

- An ambiguous version reference exits 2 ("could mean more than one thing"): use `#n` or a longer id.
- `#n` counts versions on the current exploration ("This exploration has N saved versions"), so after `switch` the same `#n` is a different version. Re-check with `design history`.
- A bare number such as `3` is accepted like `#3`, but it can clash with a version id and become ambiguous. Prefer `#n`.
- `restore` only works on paths that exist in that version or are saved in this folder; otherwise exit 1, "There is nothing to restore for …". With no paths and no design files in either place it is refused the same way.
- `restore` with paths refuses (exit 1) when files under those paths that are not designs have unsaved changes, because restoring would overwrite them. Pass specific `.pen` files rather than folders holding other work.
- The compare report goes to `design-diff/` in the design folder by default, and that folder is left out of versions.
- Compare refuses an unsafe output folder ("The report can't be written there"); choose another one.
- Saving can be refused by git signing or a hook (exit 1); report the message to the user.
