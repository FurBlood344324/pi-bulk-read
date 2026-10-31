# Changelog

## 0.1.0 — 2026-10-31

First release.

- `bulk_read` tool: files, globs and `file:start-end` ranges in one call.
- Total character budget (24000 by default); files that do not fit fall back to an outline instead
  of a partial dump, and the continuation call is printed.
- Outline with line spans for markdown headings, code declarations (control flow excluded),
  yaml/toml keys and json top-level keys.
- Real line numbers on every line; blank-line runs collapsed; trailing whitespace trimmed.
- Fail-open error reporting for missing, binary, empty, oversized and directory paths.
- Tests with no model calls or network (`bun run test/test-bulk-read.ts`).
