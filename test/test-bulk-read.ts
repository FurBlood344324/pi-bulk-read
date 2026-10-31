/**
 * bulk-read tests (no model calls, no network).
 *
 *   bun run test/test-bulk-read.ts
 *
 * Builds fixtures in a temp dir; never touches real project files.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandSpecs, outlineOf, parseSpec, renderUnits } from "../extensions/bulk-read.ts";

const TMP = mkdtempSync(join(tmpdir(), "bulk-read-test-"));
mkdirSync(join(TMP, "src", "deep"), { recursive: true });

// --- fixtures ---------------------------------------------------------------
const tsLines: string[] = ['import { readFileSync } from "node:fs";', ""];
for (let i = 0; i < 40; i++) {
	tsLines.push(`export function fn${i}(a: number) {`, "\treturn a + 1;", "}", "");
}
writeFileSync(join(TMP, "src", "big.ts"), tsLines.join("\n"), "utf-8");

writeFileSync(
	join(TMP, "src", "small.ts"),
	["// small", "export const answer = 42;", ""].join("\n"),
	"utf-8",
);

writeFileSync(
	join(TMP, "doc.md"),
	["# Title", "", "para", "", "## Section A", "text", "", "### Deeper", "x", "", "## Section B", "y", ""].join("\n"),
	"utf-8",
);

writeFileSync(
	join(TMP, "src", "ctrl.ts"),
	[
		"export function f(x: number) {",
		"\tif (x > 0) {",
		"\t\treturn 1;",
		"\t}",
		"\tfor (const y of [1]) {",
		"\t\tif (y) {",
		"\t\t\treturn y;",
		"\t\t}",
		"\t}",
		"\treturn 0;",
		"}",
		"",
	].join("\n"),
	"utf-8",
);

writeFileSync(join(TMP, "conf.yaml"), ["root:", "  a: 1", "  b: 2", "other: 3", ""].join("\n"), "utf-8");
writeFileSync(join(TMP, "src", "deep", "nested.ts"), ["export class Nested {", "  run() {", "    return 1;", "  }", "}", ""].join("\n"), "utf-8");
writeFileSync(join(TMP, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));

// --- parseSpec ---------------------------------------------------------------
assert.deepEqual(parseSpec("a.ts"), { path: "a.ts" });
assert.deepEqual(parseSpec("a.ts:10-20"), { path: "a.ts", range: [10, 20] });
assert.deepEqual(parseSpec("a.ts:10"), { path: "a.ts", range: [10, undefined] });
assert.deepEqual(parseSpec("a.ts:10-"), { path: "a.ts", range: [10, undefined] });

// --- expandSpecs: glob, range, dedupe ---------------------------------------
{
	const got = expandSpecs(["src/**/*.ts", "src/small.ts"], TMP);
	const rels = got.map((g) => g.abs.slice(TMP.length + 1)).sort();
	assert.deepEqual(rels, ["src/big.ts", "src/ctrl.ts", "src/deep/nested.ts", "src/small.ts"], "glob + dedupe");

	const ranged = expandSpecs(["src/big.ts:5-9"], TMP);
	assert.deepEqual(ranged[0].range, [5, 9], "range parsed");
}

// --- build units via renderUnits path (expand + load inside extension) ------
// loadUnit is not exported; exercise it through renderUnits using real reads.
function unitsFor(specs: string[]) {
	// Mirror of the extension's load step, kept in the test so the renderer stays pure.
	const { statSync, readFileSync } = require("node:fs");
	return expandSpecs(specs, TMP).map((s) => {
		const rel = s.abs.slice(TMP.length + 1);
		try {
			const st = statSync(s.abs);
			if (st.isDirectory()) return { abs: s.abs, rel, lines: [], total: 0, bytes: 0, range: s.range, error: "is a directory" };
			const buf = readFileSync(s.abs);
			if (buf.subarray(0, 8192).includes(0))
				return { abs: s.abs, rel, lines: [], total: 0, bytes: st.size, range: s.range, error: "binary, skipped" };
			const lines = buf.toString("utf-8").split("\n");
			if (lines[lines.length - 1] === "") lines.pop();
			const clamped = s.range
				? [Math.max(1, Math.min(s.range[0], lines.length)), Math.max(1, Math.min(s.range[1], lines.length))]
				: undefined;
			return { abs: s.abs, rel, lines, total: lines.length, bytes: st.size, range: clamped };
		} catch {
			return { abs: s.abs, rel, lines: [], total: 0, bytes: 0, range: s.range, error: "not found" };
		}
	});
}

// --- outline: markdown headings with spans ----------------------------------
{
	const [unit] = unitsFor(["doc.md"]);
	const { entries, kind } = outlineOf(unit);
	assert.equal(kind, "headings");
	assert.deepEqual(
		entries.map((e) => [e.line, e.text]),
		[
			[1, "# Title"],
			[5, "## Section A"],
			[8, "### Deeper"],
			[11, "## Section B"],
		],
	);
	assert.equal(entries[1].end, 7, "section span ends before next heading");
}

// --- outline: code symbols ---------------------------------------------------
{
	const [unit] = unitsFor(["src/big.ts"]);
	const { entries, kind } = outlineOf(unit);
	assert.equal(kind, "symbols");
	assert.ok(entries[0].text.startsWith("export function fn0"), "top-level functions listed");
	assert.ok(entries.some((e) => e.text.startsWith("export function fn7")), "later functions listed");
	const fn7 = entries.find((e) => e.text.startsWith("export function fn7"));
	assert.equal(fn7.end, fn7.line + 3, "function span covers its body");
}

// --- outline: control flow is not a symbol --------------------------------
{
	const [unit] = unitsFor(["src/ctrl.ts"]);
	const { entries } = outlineOf(unit);
	assert.deepEqual(
		entries.map((e) => e.text),
		["export function f(x: number) {"],
		"if/for/while lines are not symbols",
	);
}

// --- outline: yaml keys ------------------------------------------------------
{
	const [unit] = unitsFor(["conf.yaml"]);
	const { entries, kind } = outlineOf(unit);
	assert.equal(kind, "keys");
	assert.deepEqual(
		entries.map((e) => e.text),
		["root:", "other: 3"],
	);
}

// --- render: auto keeps small files full, big ones outlined -----------------
{
	const units = unitsFor(["src/small.ts", "src/big.ts"]);
	const res = renderUnits(units, { mode: "auto", maxChars: 20000, perFileChars: 2000 });
	assert.deepEqual(res.shownFull, ["src/small.ts"]);
	assert.deepEqual(res.outlined, ["src/big.ts"]);
	assert.match(res.text, /^\s*2\s+export const answer = 42;$/m, "line numbers are real");
	assert.match(res.text, /outline\/symbols/);
	assert.ok(res.text.length < 4000, `outline stays small (${res.text.length})`);
}

// --- render: range read shows exact numbered slice --------------------------
{
	const units = unitsFor(["src/big.ts:9-12"]);
	const res = renderUnits(units, { mode: "auto", maxChars: 20000 });
	assert.match(res.text, /lines 9-12 of/);
	assert.match(res.text, /^\s*11\s+export function fn2/m);
	assert.match(res.text, /^\s*12\s+/m);
	assert.ok(!/\s+$/.test(res.text.split("\n").slice(1).join("\n")), "no trailing whitespace");
	assert.ok(!res.text.includes("fn3("), "range does not leak past the end");
}

// --- render: hard budget never silently overflows ---------------------------
{
	const units = unitsFor(["src/big.ts", "src/small.ts", "doc.md"]);
	const res = renderUnits(units, { mode: "full", maxChars: 3000 });
	assert.ok(res.text.length <= 3600, `budget respected (got ${res.text.length})`);
	assert.match(res.text, /(continue|retry): bulk_read paths=\[/, "follow-up call is stated");
	assert.deepEqual(res.skipped, ["src/small.ts", "doc.md"], "dropped files are named, not silently lost");
	assert.match(res.text, /retry: bulk_read paths=\["src\/small\.ts", "doc\.md"\]/);
}

// --- render: errors are reported, not thrown --------------------------------
{
	const units = unitsFor(["nope.ts", "bin.dat", "src"]);
	const res = renderUnits(units, { mode: "auto", maxChars: 4000 });
	assert.match(res.text, /nope\.ts · not found/);
	assert.match(res.text, /bin\.dat · binary, skipped/);
	assert.match(res.text, /src · is a directory/);
}

// --- render: budget exhaustion names what was dropped -----------------------
{
	const units = unitsFor(["src/big.ts", "src/deep/nested.ts"]);
	const res = renderUnits(units, { mode: "full", maxChars: 2200 });
	assert.match(res.text, /continue: bulk_read|budget full/);
}

// --- extension wiring: tool registers and runs through execute ---------------
{
	const { default: bulkReadExtension } = await import("../extensions/bulk-read.ts");
	const registered: any[] = [];
	bulkReadExtension({ registerTool: (t: any) => registered.push(t) } as any);
	assert.equal(registered.length, 1, "one tool registered");
	const tool = registered[0];
	assert.equal(tool.name, "bulk_read");
	const out = await tool.execute(
		"call-1",
		{ paths: ["src/small.ts", "src/big.ts:1-6"], mode: "auto" },
		undefined,
		undefined,
		{ cwd: TMP },
	);
	const text = out.content[0].text;
	assert.match(text, /answer = 42/);
	assert.match(text, /lines 1-6 of 161/);
	assert.ok(out.details.units === 2);
}

rmSync(TMP, { recursive: true, force: true });
console.log("bulk-read: all tests passed");
