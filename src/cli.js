#!/usr/bin/env node
/**
 * gitdata — dependable, structured, organized docs as data in git.
 *
 * gitdata GUIDES; GitHub ENFORCES. Commands report and emit; they never block. `rollup --check`
 * exits non-zero so a consumer can mark it a required check in their own CI — that choice is
 * theirs, not ours.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { emitCodeowners } from "./emit-codeowners.js";
import { init, listPacks } from "./init.js";
import { describeTables, runQuery } from "./introspect.js";
import { diffLines, formatDiff, rollup } from "./rollup.js";
import { validate } from "./validate.js";

const USAGE = `gitdata — docs as data in git

  gitdata init [--pack <name>] [--root <dir>]           scaffold data/ — bare, or from a pack
  gitdata rollup [--check] [--diff] [--json] [--root <dir>]
                                                          regenerate views | report drift without writing
  gitdata validate [--root <dir>]                        check rows against data/_schema/*.schema.yml
  gitdata emit codeowners [--check] [--root <dir>] [--out <path>]
                                                          emit .github/CODEOWNERS from data/*/_owners.yml
  gitdata tables [--json] [--root <dir>]                 list tables, columns, inferred types, row counts
  gitdata query "<SQL>" [--json] [--root <dir>]
                                                          run a read-only SQL statement against the projection
  gitdata packs                                          list available packs

Options:
  --root <dir>   repo root (default: cwd). Data lives in <root>/data.
  --check        report drift without writing; exits non-zero if anything drifted or is missing.
  --diff         with --check: print the line diff for each drifted/missing view. No effect
                 without --check; a normal rollup writes, it does not compare.
  --json         with --check, tables, or query: emit structured output instead of a plain-text
                 listing. No effect on --check without --check itself. Combine with --diff to
                 include diff content in --check's report.
  --out <path>   emit codeowners: output path (default: <root>/.github/CODEOWNERS)
`;

// Boolean flags recognized anywhere in argv, and the value-taking flags with where their value
// lands in `args`. Kept in one place so positional-argument extraction (`rest`, below) knows
// exactly what to skip past — `query`'s SQL text is the one positional argument any command takes.
const BOOL_FLAGS = ["--check", "--diff", "--json"];
const VALUE_FLAGS = [["--root", "root"], ["--pack", "pack"], ["--out", "out"]];

function parseArgs(argv) {
  // A subcommand is argv[1] when the command itself takes one and it isn't a flag — `emit
  // codeowners`, never `rollup --check` mistaken for a subcommand, and never `query`'s own SQL
  // text (which is a positional argument, not a subcommand).
  const sub = argv[0] === "emit" && argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
  const args = {
    command: argv[0],
    sub,
    check: argv.includes("--check"),
    diff: argv.includes("--diff"),
    json: argv.includes("--json"),
    root: process.cwd(),
    pack: null,
    out: null,
  };
  const consumed = new Set([0]);
  if (sub) consumed.add(1);
  for (const [flag, key] of VALUE_FLAGS) {
    const i = argv.indexOf(flag);
    if (i === -1) continue;
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    args[key] = key === "root" ? resolve(argv[i + 1]) : argv[i + 1];
    consumed.add(i);
    consumed.add(i + 1);
  }
  argv.forEach((a, i) => {
    if (BOOL_FLAGS.includes(a)) consumed.add(i);
  });
  // Whatever argv positions no flag or subcommand claimed — for `query`, that is its SQL statement.
  args.rest = argv.filter((_, i) => !consumed.has(i));
  return args;
}

function cmdPacks() {
  const packs = listPacks();
  if (packs.length === 0) {
    console.log("  no packs bundled");
    return 0;
  }
  for (const p of packs) console.log(`  ${p.name.padEnd(22)} ${p.title ?? ""}`);
  console.log(`\n  install one:  gitdata init --pack ${packs[0].name}`);
  return 0;
}

function cmdInit({ root, pack }) {
  const { written, skipped } = init({ root, pack });

  for (const f of written) console.log(`  ✎ ${f}`);
  for (const f of skipped) console.log(`  · ${f} (exists — left alone)`);

  console.log(`\n  ${written.length} file(s) written, ${skipped.length} left alone.`);
  if (written.length > 0) {
    console.log("\nNext:");
    if (pack) {
      console.log("  1. Add a row to a generated table — copy its _template.md if it has one");
    } else {
      console.log("  1. mkdir data/<table>, add a row (.md with frontmatter)");
      console.log("     then declare a view in data/_views/<id>.view.yml");
    }
    console.log("  2. gitdata rollup          # writes the view");
    console.log("  3. gitdata rollup --check  # in CI: has anything drifted?");
    console.log("     (ran init through npx? use the same npx invocation in place of `gitdata`)");
  }
  return 0;
}

const isBad = (r) => r.status === "drifted" || r.status === "missing";

/**
 * The structured counterpart to the plain-text listing — `--check --json`'s report. `--check`
 * already computes both sides of the comparison per view (`compiled`, `committed`); this is what
 * surfaces that instead of collapsing it to a status string, so a caller can consume drift without
 * scraping stdout. Diff content rides along only when `--diff` is also given, and only for views
 * that are not clean — an unchanged view has nothing to show.
 */
function jsonReport(results, { diff }) {
  const views = results.map((r) => {
    const view = { id: r.id, out: r.out, status: r.status };
    if (diff && isBad(r)) view.diff = diffLines(r.committed, r.compiled);
    return view;
  });
  return {
    views,
    summary: {
      total: results.length,
      unchanged: results.filter((r) => r.status === "unchanged").length,
      drifted: results.filter((r) => r.status === "drifted").length,
      missing: results.filter((r) => r.status === "missing").length,
    },
  };
}

async function cmdRollup({ root, check, diff, json }) {
  const results = await rollup({ dataRoot: resolve(root, "data"), repoRoot: root, check });

  // Both flags are check-mode reporting detail, not part of what a writing rollup does — they
  // are simply inert without --check rather than an error, matching how --check itself already
  // reads as a no-op modifier on top of the base command.
  if (check && json) {
    console.log(JSON.stringify(jsonReport(results, { diff }), null, 2));
    return results.some(isBad) ? 1 : 0;
  }

  if (results.length === 0) {
    console.log("  no views found — add data/_views/<name>.view.yml");
    return 0;
  }

  for (const r of results) {
    const mark = { written: "✎", unchanged: "·", drifted: "✗", missing: "✗" }[r.status];
    console.log(`  ${mark} ${r.id.padEnd(24)} ${r.status.padEnd(10)} ${r.out}`);
    if (check && diff && isBad(r)) {
      for (const line of formatDiff(diffLines(r.committed, r.compiled)).split("\n")) {
        console.log(`      ${line}`);
      }
    }
  }

  const bad = results.filter(isBad);
  if (check && bad.length > 0) {
    console.log(`\n  ${bad.length} view(s) out of date — run \`gitdata rollup\` and commit the result.`);
    return 1;
  }
  console.log(`\n  ${results.length} view(s) ${check ? "checked" : "rolled up"}.`);
  return 0;
}

function cmdValidate({ root }) {
  const { tables, issues } = validate({ dataRoot: resolve(root, "data") });

  if (tables.length === 0) {
    console.log("  no schemas found — add data/_schema/<table>.schema.yml");
    return 0;
  }

  for (const i of issues) {
    console.log(`  ✗ ${i.table.padEnd(16)} ${String(i.file).padEnd(28)} ${i.rule.padEnd(9)} ${i.message}`);
  }

  if (issues.length > 0) {
    console.log(`\n  ${issues.length} issue(s) across ${tables.length} table(s) checked.`);
    return 1;
  }
  console.log(`  ${tables.length} table(s) checked, 0 issues.`);
  return 0;
}

async function cmdEmitCodeowners({ root, check, out }) {
  const outPath = resolve(root, out ?? ".github/CODEOWNERS");
  const result = emitCodeowners({ dataRoot: resolve(root, "data"), repoRoot: root, outPath, check });

  if (result.status === "empty") {
    console.log("  no ownership declared — add data/<table>/_owners.yml, then re-run");
    return 0;
  }

  const mark = { written: "✎", unchanged: "·", drifted: "✗", missing: "✗" }[result.status];
  console.log(`  ${mark} ${relative(root, result.out).padEnd(24)} ${result.status}`);

  if (check && (result.status === "drifted" || result.status === "missing")) {
    console.log("\n  CODEOWNERS is out of date — run `gitdata emit codeowners` and commit the result.");
    return 1;
  }
  console.log(`\n  codeowners ${check ? "checked" : "emitted"}.`);
  return 0;
}

async function cmdTables({ root, json }) {
  const tables = await describeTables(resolve(root, "data"));

  if (json) {
    console.log(JSON.stringify(tables, null, 2));
    return 0;
  }
  if (tables.length === 0) {
    console.log("  no tables found — add data/<table>/<row>.md");
    return 0;
  }
  for (const t of tables) {
    console.log(`${t.table} (${t.rows} row${t.rows === 1 ? "" : "s"})`);
    for (const c of t.columns) console.log(`  ${c.name.padEnd(24)} ${c.type}`);
    console.log("");
  }
  return 0;
}

/** A readable plain-text table for `query`'s default (non-`--json`) output. */
function formatRows(rows) {
  if (rows.length === 0) return "  (0 rows)";
  const columns = Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  const lines = [line(columns), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) lines.push(line(columns.map((c) => cell(r[c]))));
  lines.push(`\n  ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}

async function cmdQuery({ root, json, rest }) {
  const [sql] = rest;
  if (!sql) throw new Error('query requires a SQL statement, e.g. gitdata query "SELECT * FROM <table>"');
  const rows = await runQuery(resolve(root, "data"), sql);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log(formatRows(rows));
  return 0;
}

const argv = process.argv.slice(2);
// Help and version are answers, not errors — `gitdata --help && ...` must not read as a broken
// install, and CI needs a way to ask an install what it is.
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-V")) {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}

const args = parseArgs(argv);
try {
  if (args.command === "rollup") process.exit(await cmdRollup(args));
  if (args.command === "init") process.exit(cmdInit(args));
  if (args.command === "validate") process.exit(cmdValidate(args));
  if (args.command === "emit" && args.sub === "codeowners") process.exit(await cmdEmitCodeowners(args));
  if (args.command === "packs") process.exit(cmdPacks());
  if (args.command === "tables") process.exit(await cmdTables(args));
  if (args.command === "query") process.exit(await cmdQuery(args));
  console.log(USAGE);
  process.exit(args.command ? 1 : 0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
