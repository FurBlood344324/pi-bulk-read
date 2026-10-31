// @ts-nocheck
/**
 * bulk-read — read long files and many files in ONE budgeted call.
 *
 * PROBLEM: `read` stops at 2000 lines / 50KB and gives no line numbers, so a long file is
 * paged with offset/limit: every page is a separate turn, and every turn re-processes the whole
 * context. Measurement on 306 sessions: continued reads are 5.4% of reads under 8k, but 38.8%
 * above 32k.
 *
 * SOLUTION (three ideas, one tool):
 *  1) BATCH: `paths: ["a.ts", "b.py:120-260", "src/**\/*.md"]` — many files + ranges in one turn.
 *  2) BUDGET: a total character budget (default 24000). A file that does not fit is not dumped
 *     partially: it falls back to an OUTLINE, and what was skipped plus the exact follow-up call
 *     is stated explicitly. No silent truncation.
 *  3) OUTLINE: heading/symbol map with line spans (markdown headings, code declarations,
 *     yaml/toml keys, json top-level keys). The model sees the map first, then asks for the one
 *     range it needs.
 *
 * DESIGN DECISIONS:
 *  - Line numbers are ALWAYS printed: the only stable address for a range request and for `edit`.
 *  - Runs of blank lines collapse and trailing whitespace is trimmed (no meaning lost, ~10-20%
 *    saved); printed numbers are the real file lines, so an elision stays visible.
 *  - `grep` already exists: no search mode here (single ownership). This tool only batches reads.
 *  - Fail-open: one bad file (missing / binary / too large) never drops the result; it is reported
 *    as a line.
 *
 * ENV: BULK_READ_MAX_CHARS (24000) · BULK_READ_PER_FILE (9600) · BULK_READ_OFF=1
 * Disable: set BULK_READ_OFF=1 or remove the package.
 */
import { globSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = Number(process.env.BULK_READ_MAX_CHARS ?? 24000);
const PER_FILE_CHARS = Number(process.env.BULK_READ_PER_FILE ?? 9600);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const OUTLINE_MAX_ENTRIES = 120;
const HEAD_LINES = 12;
const OFF = process.env.BULK_READ_OFF === "1";

export interface Unit {
	/** Absolute path. */
	abs: string;
	/** Display path (relative to cwd when under it). */
	rel: string;
	/** File split into lines (no trailing empty line). */
	lines: string[];
	total: number;
	bytes: number;
	/** Requested 1-indexed inclusive range, clamped. */
	range?: [number, number];
	error?: string;
}

// --- path specs: "f.ts", "f.ts:120-260", "f.ts:40", "f.ts:40-", "src/**/*.md" ---

export function parseSpec(spec: string): { path: string; range?: [number, number?] } {
	const m = /^(.*?):(\d+)(?:-(\d*))?$/.exec(spec.trim());
	if (!m) return { path: spec.trim() };
	return { path: m[1], range: [Number(m[2]), m[3] === undefined || m[3] === "" ? undefined : Number(m[3])] };
}

function hasGlob(p: string): boolean {
	return /[*?[\]{}]/.test(p);
}

/** Expand specs to concrete files, preserving order and dropping duplicates. */
export function expandSpecs(specs: string[], cwd: string): { abs: string; range?: Unit["range"] }[] {
	const out: { abs: string; range?: Unit["range"] }[] = [];
	const seen = new Set<string>();
	const push = (abs: string, range?: [number, number?]) => {
		const key = `${abs}:${range?.[0] ?? ""}-${range?.[1] ?? ""}`;
		if (seen.has(key) || out.length >= MAX_FILES) return;
		seen.add(key);
		out.push({ abs, range: range ? [range[0], range[1] ?? Number.MAX_SAFE_INTEGER] : undefined });
	};

	for (const raw of specs) {
		let { path: p, range } = parseSpec(raw);
		const abs = isAbsolute(p) ? p : resolve(cwd, p);
		// A real path may itself contain a colon ("a:b:c"), so keep the literal path when it exists.
		if (range && !exists(abs) && !hasGlob(p)) {
			const literal = isAbsolute(raw) ? raw : resolve(cwd, raw);
			if (exists(literal)) {
				p = raw;
				range = undefined;
			}
		}
		const target = isAbsolute(p) ? p : resolve(cwd, p);
		if (hasGlob(p)) {
			let matches: string[] = [];
			try {
				matches = globSync(p, { cwd }).sort();
			} catch {
				matches = [];
			}
			if (matches.length === 0) {
				out.push({ abs: target, range: range ? [range[0], range[1] ?? Number.MAX_SAFE_INTEGER] : undefined });
				continue;
			}
			for (const m of matches) push(resolve(cwd, m), range);
			continue;
		}
		push(target, range);
	}
	return out;
}

function exists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function loadUnit(abs: string, rel: string, range?: Unit["range"]): Unit {
	const empty: Unit = { abs, rel, lines: [], total: 0, bytes: 0, range };
	let st;
	try {
		st = statSync(abs);
	} catch {
		return { ...empty, error: "not found" };
	}
	if (st.isDirectory()) return { ...empty, error: "is a directory (pass a glob, e.g. dir/**/*.ts)" };
	if (st.size === 0) return { ...empty, error: "empty file" };
	if (st.size > MAX_FILE_BYTES) return { ...empty, bytes: st.size, error: `too large (${fmtBytes(st.size)})` };

	let buf: Buffer;
	try {
		buf = readFileSync(abs);
	} catch (err) {
		return { ...empty, error: `unreadable (${(err as Error).message})` };
	}
	if (buf.subarray(0, 8192).includes(0)) return { ...empty, bytes: st.size, error: "binary, skipped" };

	const lines = splitLines(buf.toString("utf-8"));
	const total = lines.length;
	let clamped: Unit["range"] | undefined;
	if (range) {
		const from = Math.max(1, Math.min(range[0], total));
		const to = Math.max(from, Math.min(range[1], total));
		clamped = [from, to];
	}
	return { abs, rel, lines, total, bytes: st.size, range: clamped };
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// --- outline: structure map with line spans --------------------------------

const MD_EXT = /\.(md|mdx|markdown|rst)$/i;
const CFG_EXT = /\.(ya?ml|toml|ini|cfg|conf|env|properties)$/i;
const JSON_EXT = /\.(json|jsonc|json5)$/i;

const SYMBOL_PATTERNS: RegExp[] = [
	// TS/JS/Rust/Go/Java/C# declarations and top-level bindings
	/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|module|namespace|record|protocol|extension)\b/,
	/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function\b|[A-Za-z_$][\w$]*\s*=>)/,
	/^(?:pub\s+)?(?:async\s+)?(?:def|fn|func|fun)\s+[A-Za-z_]\w*/,
	/^(?:pub\s+)?(?:struct|enum|impl|trait|mod|type|interface)\s+[A-Za-z_]\w*/,
	/^#\[|^@\w+/,
	// method signatures inside a class body (indented)
	/^\s{1,6}(?!(?:if|for|while|switch|catch|else|do|try|finally|return|throw|new|delete|await|yield|function|typeof|void|with)\b)(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+|override\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+)?\{\s*$/,
];

export interface OutlineEntry {
	line: number;
	end: number;
	text: string;
}

/** Structure map: headings/symbols plus the line span each one covers. */
export function outlineOf(unit: Unit): { entries: OutlineEntry[]; kind: string } {
	const { lines, rel } = unit;
	const hits: { line: number; text: string }[] = [];
	const kind = MD_EXT.test(rel) ? "headings" : CFG_EXT.test(rel) ? "keys" : JSON_EXT.test(rel) ? "keys" : "symbols";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		let hit = false;
		if (kind === "headings") hit = /^#{1,6}\s/.test(line);
		else if (kind === "keys") {
			hit = JSON_EXT.test(rel)
				? /^ {2}"[^"]+"\s*:/.test(line)
				: /^[A-Za-z_][\w.-]*\s*:/.test(line) || /^\[[^\]]+\]\s*$/.test(line);
		} else {
			for (const re of SYMBOL_PATTERNS) {
				if (re.test(line)) {
					hit = true;
					break;
				}
			}
		}
		if (hit) hits.push({ line: i + 1, text: line.replace(/\s+$/, "") });
		if (hits.length > OUTLINE_MAX_ENTRIES * 4) break;
	}

	const entries: OutlineEntry[] = hits.slice(0, OUTLINE_MAX_ENTRIES).map((h, idx) => {
		const next = hits[idx + 1]?.line ?? unit.total + 1;
		const end = Math.max(h.line, Math.min(next - 1, unit.total));
		return { line: h.line, end, text: h.text.trim().slice(0, 160) };
	});
	return { entries, kind };
}

// --- rendering --------------------------------------------------------------

function padWidth(total: number): number {
	return String(total).length;
}

/** 1-indexed [from,to]; real line numbers, blanks collapsed to one, trailing ws trimmed. */
function renderLines(lines: string[], from: number, to: number, collapseBlanks = true): string {
	const width = padWidth(to);
	const out: string[] = [];
	let prevBlank = false;
	for (let i = from; i <= to; i++) {
		const text = (lines[i - 1] ?? "").replace(/\s+$/, "");
		if (!text) {
			if (collapseBlanks && prevBlank) continue;
			prevBlank = true;
		} else prevBlank = false;
		out.push(`${String(i).padStart(width)}  ${text}`.trimEnd());
	}
	return out.join("\n");
}

/** Preview lines: blanks dropped, long lines cut at `cap` (head lines of an outline). */
function previewLines(lines: string[], from: number, to: number, cap = 240): string {
	const width = padWidth(to);
	const out: string[] = [];
	for (let i = from; i <= to; i++) {
		const raw = (lines[i - 1] ?? "").replace(/\s+$/, "");
		if (!raw) continue;
		out.push(`${String(i).padStart(width)}  ${raw.length > cap ? `${raw.slice(0, cap)}…` : raw}`);
	}
	return out.join("\n");
}

function head(text: string, n: number): string {
	const lines = text.split("\n");
	if (lines.length <= n) return text;
	return `${lines.slice(0, n).join("\n")}\n…`;
}

/** Render one unit in full, possibly cut at budget. Returns next start line when cut. */
function renderFull(unit: Unit, budget: number): { text: string; next?: number } {
	const [from, to] = unit.range ?? [1, unit.total];
	const header = `── ${unit.rel} · lines ${from}-${to} of ${unit.total} · ${fmtBytes(unit.bytes)} ──`;
	let text = `${header}\n${renderLines(unit.lines, from, to)}`;
	if (text.length <= budget) return { text };

	// Out of budget: fit what fits from the start and give the continuation address.
	const perLine = Math.max(20, Math.floor((text.length - header.length) / Math.max(1, to - from + 1)));
	const fitLines = Math.max(10, Math.floor((budget - header.length - 80) / (perLine + 8)));
	const cut = Math.min(to, from + fitLines - 1);
	text = `${header}\n${renderLines(unit.lines, from, cut)}`;
	return { text: `${text}\n… ${to - cut} more lines (${cut + 1}-${to})`, next: cut + 1 };
}

function renderOutline(unit: Unit, budget: number): string {
	const { entries, kind } = outlineOf(unit);
	const header = `── ${unit.rel} · outline/${kind} · ${unit.total} lines · ${fmtBytes(unit.bytes)} ──`;
	const parts: string[] = [header];

	if (!unit.range) {
		const headTo = Math.min(HEAD_LINES, unit.total);
		parts.push(previewLines(unit.lines, 1, headTo));
		if (unit.total > headTo) parts.push(`  ⋮`);
	}

	if (entries.length === 0) {
		// No structure (plain text/log): head + tail, with the gap stated explicitly.
		const tailFrom = Math.max(1, unit.total - 7);
		if (unit.total > HEAD_LINES + 8) parts.push(previewLines(unit.lines, tailFrom, unit.total));
		parts.push(`[no structure found: ${unit.total} lines · ask for a range: "${unit.rel}:A-B"]`);
		return head(parts.join("\n"), 200);
	}

	for (const e of entries) {
		const span = e.end > e.line ? `${e.line}-${e.end}` : `${e.line}`;
		parts.push(`${span.padStart(padWidth(unit.total) + 6)}  ${e.text}`);
	}
	if (entries.length >= OUTLINE_MAX_ENTRIES) parts.push(`… outline truncated at ${OUTLINE_MAX_ENTRIES} entries`);
	parts.push(`[full text: "${unit.rel}:A-B" · e.g. "${unit.rel}:${entries[0].line}-${Math.min(entries[0].end, entries[0].line + 40)}"]`);
	return head(parts.join("\n"), 400);
}

export interface RenderOptions {
	mode?: "auto" | "full" | "outline";
	maxChars?: number;
	perFileChars?: number;
}

export interface RenderResult {
	text: string;
	shownFull: string[];
	outlined: string[];
	skipped: string[];
	nextStart: Map<string, number>;
}

/** Budgeted multi-file render. Pure: no I/O, no session state. */
export function renderUnits(units: Unit[], opts: RenderOptions = {}): RenderResult {
	const mode = opts.mode ?? "auto";
	const maxChars = opts.maxChars ?? MAX_CHARS;
	const perFile = opts.perFileChars ?? PER_FILE_CHARS;
	const shownFull: string[] = [];
	const outlined: string[] = [];
	const skipped: string[] = [];
	const nextStart = new Map<string, number>();
	const blocks: string[] = [];
	let used = 0;

	for (const unit of units) {
		if (unit.error) {
			blocks.push(`── ${unit.rel} · ${unit.error} ──`);
			used += 60;
			skipped.push(unit.rel);
			continue;
		}
		const remaining = maxChars - used;
		const wantFull =
			mode === "full" ? true : mode === "outline" ? false : unit.range ? true : unit.bytes * 1.15 <= perFile;

		if (wantFull) {
			const fullText = renderLines(unit.lines, unit.range?.[0] ?? 1, unit.range?.[1] ?? unit.total);
			const size = fullText.length + 120;
			if (size <= remaining) {
				const rendered = renderFull(unit, Math.min(remaining, size));
				blocks.push(rendered.text);
				used += rendered.text.length + 2;
				shownFull.push(unit.rel);
				continue;
			}
			if (remaining > 1500) {
				const rendered = renderFull(unit, remaining);
				blocks.push(rendered.text);
				used += rendered.text.length + 2;
				shownFull.push(unit.rel);
				if (rendered.next) nextStart.set(unit.rel, rendered.next);
				continue;
			}
			// Budget exhausted: an outline is cheap, try that.
			if (remaining > 900) {
				const rendered = renderOutline(unit, remaining);
				blocks.push(rendered);
				used += rendered.length + 2;
				outlined.push(unit.rel);
				continue;
			}
			skipped.push(unit.rel);
			continue;
		}

		const rendered = renderOutline(unit, Math.max(0, remaining));
		if (rendered.length <= remaining) {
			blocks.push(rendered);
			used += rendered.length + 2;
			outlined.push(unit.rel);
		} else if (remaining > 900) {
			blocks.push(head(rendered, 40));
			used += 1200;
			outlined.push(unit.rel);
		} else {
			skipped.push(unit.rel);
		}
	}

	const notes: string[] = [];
	if (nextStart.size > 0) {
		const cont = [...nextStart.entries()]
			.map(([rel, next]) => `"${rel}:${next}-"`)
			.slice(0, 4)
			.join(", ");
		notes.push(`continue: bulk_read paths=[${cont}]`);
	}
	if (skipped.length > 0) {
		const again = skipped
			.slice(0, 4)
			.map((rel) => `"${rel}"`)
			.join(", ");
		notes.push(`budget full · not shown: ${skipped.slice(0, 8).join(", ")}`);
		if (nextStart.size === 0) notes.push(`retry: bulk_read paths=[${again}]`);
	}
	const header = `[bulk_read] ${units.length} file(s) · mode=${mode} · budget ${maxChars} chars`;
	const footer = notes.length ? `\n\n${notes.join("\n")}` : "";
	return { text: `${header}\n${blocks.join("\n")}${footer}`, shownFull, outlined, skipped, nextStart };
}

// --- extension ---------------------------------------------------------------

export default function bulkReadExtension(pi: ExtensionAPI) {
	if (OFF) return;

	pi.registerTool({
		name: "bulk_read",
		label: "Bulk Read",
		description: [
			"Read multiple files, and long files, in one budgeted call. Returns real line numbers.",
			'Paths accept optional ranges: "src/app.ts:120-260", "src/app.ts:40-", and globs: "src/**/*.ts".',
			'mode="auto" (default) shows small files in full and switches big ones to an outline (headings / symbols / config keys with line spans) instead of dumping them.',
			'mode="outline" for the structure map only; mode="full" to force content.',
			"Total output is capped (default 24000 chars); anything omitted is reported with the exact follow-up call. Prefer this over paging with read/offset when touching 2+ files or any file above ~800 lines.",
		].join(" "),
		promptSnippet: "Read many files or long files in one budgeted call (line numbers, ranges, outline for big files)",
		promptGuidelines: [
			'Use bulk_read instead of read/offset paging for long files: first mode="outline", then request exact "file:A-B" ranges.',
			"Batch independent file reads into one bulk_read call rather than one read per turn.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description: 'Files, globs, or "file:start-end" ranges',
				minItems: 1,
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("full"), Type.Literal("outline")], {
					description: "auto (default) = full for small, outline for big",
				}),
			),
			max_chars: Type.Optional(Type.Number({ description: `Total output budget in chars (default ${MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const maxChars = Math.max(2000, Math.min(params.max_chars ?? MAX_CHARS, 200000));
			const specs = params.paths.map((p) => p.trim()).filter(Boolean);
			if (specs.length === 0) {
				return { content: [{ type: "text", text: "[bulk_read] empty paths" }], details: { units: 0 } };
			}

			const units: Unit[] = expandSpecs(specs, cwd).map((spec) => {
				const rel = relative(cwd, spec.abs) || spec.abs;
				return loadUnit(spec.abs, rel.startsWith("..") ? spec.abs : rel, spec.range);
			});

			const result = renderUnits(units, { mode: params.mode, maxChars });
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					units: units.length,
					shownFull: result.shownFull,
					outlined: result.outlined,
					skipped: result.skipped,
					chars: result.text.length,
					budget: maxChars,
				},
			};
		},
	});
}
