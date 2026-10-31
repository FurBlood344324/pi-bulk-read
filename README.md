# pi-bulk-read

Read many files — or one long file — in **one budgeted call** for [pi](https://pi.dev).
Ranges, globs, real line numbers, and an outline for whatever does not fit.

`read` stops at 2000 lines / 50KB and returns no line numbers, so a 3000-line file becomes three
turns of paging with `offset`/`limit`, and every turn re-processes the whole context. Measured over
306 sessions: continued reads (the same file opened again with a larger offset) are **5.4%** of
reads under 8k, but **38.8%** above 32k. The problem is not the file; it is the access pattern.

## What it does

| Idea | Behaviour |
|---|---|
| **Batch** | `paths` accepts files, globs and `file:start-end` ranges together — one call, one turn. |
| **Budget** | Output is capped (24000 chars by default). A file that does not fit is **not** dumped partially: it falls back to an outline, and the skipped part plus the exact follow-up call is printed. No silent truncation. |
| **Outline** | Markdown headings, code declarations, yaml/toml keys and json top-level keys with their **line spans**. Read the map, then ask for the one range you need. |

Line numbers are always printed: the only stable address for a `file:A-B` range and for `edit`.
Runs of blank lines collapse and trailing whitespace is trimmed; printed numbers stay real, so any
elision remains visible.

## Install

```bash
pi install npm:pi-bulk-read
```

Or add `"npm:pi-bulk-read"` to the `packages` list in `~/.pi/agent/settings.json`. The tool loads in
every session; `/reload` picks it up without restarting.

## Usage

```
bulk_read paths=["src/app.ts", "src/queue.py:120-260", "docs/**/*.md"]
```

Big file, first look — an outline with line spans (real output):

```
[bulk_read] 1 file(s) · mode=outline · budget 24000 chars
── extensions/bulk-read.ts · outline/symbols · 465 lines · 17.4KB ──
 1  // @ts-nocheck
 2  /**
 3   * bulk-read — read long files and many files in ONE budgeted call.
 ...
 ⋮
    43-58  export interface Unit {
    59-64  export function parseSpec(spec: string): { path: string; range?: [number, number?] } {
    65-69  function hasGlob(p: string): boolean {
   70-110  export function expandSpecs(specs: string[], cwd: string): { abs: string; range?: Unit["range"] }[] {
  111-119  function exists(p: string): boolean {
  120-125  function splitLines(text: string): string[] {
[full text: "extensions/bulk-read.ts:A-B" · e.g. "extensions/bulk-read.ts:43-58"]
```

Then the range you actually need:

```
bulk_read paths=["extensions/bulk-read.ts:43-58"]
```

### Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `paths` | required | Files, globs, or `"file:start-end"` / `"file:start-"` ranges. |
| `mode` | `auto` | `auto` = full text for files that fit, outline for the rest. `full` forces content (cut at the budget, with a continuation address). `outline` forces the map. |
| `max_chars` | `24000` | Total output budget for the call. |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `BULK_READ_MAX_CHARS` | `24000` | Default total budget per call. |
| `BULK_READ_PER_FILE` | `9600` | Above this a file is outlined instead of dumped (`auto` mode). |
| `BULK_READ_OFF` | unset | `1` disables the tool. |

## What it does not do

- **No search mode.** `grep` already does that, and a second implementation would drift. This tool
  only batches reads.
- **The outline is heuristic** (regex-based structure detection), not a language server. When no
  structure is found — plain text, logs — you get head + tail and are told to ask for a range.
- **No silent loss.** Missing, binary, empty, oversized (>5MB) and directory paths are reported as
  lines in the result, never dropped.

## Tests

No model calls, no network — fixtures are built in a temp directory:

```bash
bun run test/test-bulk-read.ts
```

Covers range/glob parsing, outline spans for markdown/code/yaml, control flow being excluded from
the symbol map, budget behaviour and continuation calls, error reporting, and the real `execute`
path of the registered tool.

## License

MIT
