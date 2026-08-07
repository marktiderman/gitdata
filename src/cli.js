#!/usr/bin/env node
/**
 * gitdata — dependable, structured, organized docs as data in git.
 *
 * gitdata GUIDES; GitHub ENFORCES. Commands report and emit; they never block. `rollup --check`
 * exits non-zero so a consumer can mark it a required check in their own CI — that choice is
 * theirs, not ours.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { doctor, exitCode } from "./doctor.js";
import { emitCodeowners } from "./emit-codeowners.js";
import { init, listPacks } from "./init.js";
import { describeTables, runQuery } from "./introspect.js";
import { diffLines, formatDiff, rollup } from "./rollup.js";
import { describeStores } from "./stores.js";
import { validate } from "./validate.js";

const USAGE = `gitdata — docs as data in git

  gitdata init [--pack <name>] [--root <dir>] [--data <dir>]
                                                          scaffold the data root — bare, or from a pack
  gitdata rollup [--check] [--diff] [--json] [--root <dir>] [--data <dir>]
                                                          regenerate views | report drift without writing
  gitdata validate [--root <dir>] [--data <dir>]         check rows against <data>/_schema/*.schema.yml
  gitdata doctor [--check] [--strict] [--json] [--offline] [--root <dir>] [--data <dir>]
                                                          one compliance report: engine, install, drift, schemas
  gitdata emit codeowners [--check] [--root <dir>] [--data <dir>] [--out <path>]
                                                          emit .github/CODEOWNERS from <data>/*/_owners.yml
  gitdata stores [--json] [--root <dir>]                 every data/ trellis below <dir>, and what is in it
  gitdata tables [--json] [--root <dir>] [--data <dir>]  list tables, columns, inferred types, row counts
  gitdata query "<SQL>" [--json] [--root <dir>] [--data <dir>]
                                                          run a read-only SQL statement against the projection
  gitdata packs                                          list available packs

Options:
  --root <dir>   repo root (default: cwd). Data lives in <root>/data unless --data says otherwise.
                 --root is always the repo: the boundary a view's "out:" may not escape, the base
                 relative paths resolve against, and where CODEOWNERS is written and its patterns
                 are anchored. --data changes where the tables are read from, and nothing else.
  --data <dir>   the directory holding the tables (default: <root>/data), relative to --root or
                 absolute, and it must sit inside --root. For a repo that needs a SECOND store
                 beside the one it already has — a machine-owned table set that a generator
                 rewrites wholesale must not share a root with hand-authored rows, because one
                 rollup regenerating both is wrong. --data data/generated reads and writes tables
                 at data/generated/; --root data/generated would have put them at
                 data/generated/data/ and moved the repo root somewhere that is not the repo
                 root. Not accepted with \`init --pack\`.
  --check        report drift without writing; exits non-zero if anything drifted or is missing.
                 doctor: exit 1 if any finding is an error. Without it, doctor always exits 0.
  --strict       doctor: --check, plus warnings count as failures. No effect elsewhere.
  --offline      doctor: skip the one check that contacts the registry (GD004).
  --diff         with --check: print the line diff for each drifted/missing view. No effect
                 without --check; a normal rollup writes, it does not compare.
  --json         with --check, doctor, stores, tables, or query: emit structured output instead
                 of a plain-text listing. Combine with --diff to include diff content in
                 --check's report.
  --out <path>   emit codeowners: output path (default: <root>/.github/CODEOWNERS)

The doctor check catalog, with every ID and its default severity: docs/DOCTOR.md
`;

// Boolean flags recognized anywhere in argv, and the value-taking flags with where their value
// lands in `args`. Kept in one place so positional-argument extraction (`rest`, below) knows
// exactly what to skip past — `query`'s SQL text is the one positional argument any command takes.
const BOOL_FLAGS = ["--check", "--diff", "--json", "--strict", "--offline"];
const VALUE_FLAGS = [["--root", "root"], ["--data", "data"], ["--pack", "pack"], ["--out", "out"]];

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
    // --strict IS --check plus a wider net; a consumer who types only --strict means to gate.
    strict: argv.includes("--strict"),
    offline: argv.includes("--offline"),
    root: process.cwd(),
    data: null,
    pack: null,
    out: null,
  };
  const consumed = new Set([0]);
  if (sub) consumed.add(1);
  for (const [flag, key] of VALUE_FLAGS) {
    const i = argv.indexOf(flag);
    if (i === -1) continue;
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    args[key] = argv[i + 1];
    consumed.add(i);
    consumed.add(i + 1);
  }
  // `--root` is the one path named from outside the repo, so it resolves against the shell's cwd.
  // Everything else names a place INSIDE that repo and resolves against it — `--out` already did,
  // and `--data` doing anything else would make `--root /repo --data data/sdk` mean a different
  // directory depending on where the caller happened to be standing. `resolve` leaves an absolute
  // value alone, so an absolute `--data` is still accepted (and still has to be inside the root).
  args.root = resolve(args.root);
  if (args.data !== null) args.data = resolve(args.root, args.data);
  argv.forEach((a, i) => {
    if (BOOL_FLAGS.includes(a)) consumed.add(i);
  });
  // Whatever argv positions no flag or subcommand claimed — for `query`, that is its SQL statement.
  args.rest = argv.filter((_, i) => !consumed.has(i));
  return args;
}

/**
 * Where the tables live — the ONE place this is decided, for every command.
 *
 * `<root>/data` is the default and remains the whole story for a repo with a single store. A flag
 * honoured by `validate` but not by `rollup` would be worse than no flag at all: the two would
 * disagree about what the data even is, and each would be right about a different directory. So
 * every command asks here.
 *
 * `--data` exists for the repo that needs a second store beside the one it already has. A
 * machine-owned table set — rewritten wholesale by a generator — must not share a root with
 * hand-authored rows, because a single `rollup` regenerating both is wrong. The only way to
 * express that before was `--root data/generated`, which lands the tables at
 * `data/generated/data/` and tells every other part of the tool that the repo root is somewhere
 * it is not.
 *
 * It must resolve inside `--root`, and not be `--root` itself. Both refusals are about what the
 * other consumers of `--root` would then emit rather than about trust: `emit codeowners` anchors
 * its patterns at the data root's path relative to the repo, so a root-equal data dir renders
 * `/**` — a rule owning the entire repo, from a file claiming to own `data/` — and an outside one
 * renders `/../elsewhere/**`, which GitHub does not honour and no reader can act on.
 */
function dataRootOf({ root, data }) {
  if (data === null) return resolve(root, "data");

  const rel = relative(root, data);
  if (rel === "") throw new Error(`--data must be a directory inside --root, not --root itself — ${data}`);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`--data must be inside --root — ${data} is not under ${root}`);
  }
  return data;
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

function cmdInit({ root, data, pack }) {
  const dataRoot = dataRootOf({ root, data });
  const { written, skipped } = init({ root, pack, dataRoot });
  // The instructions below name real paths, so they follow --data. Telling someone who scaffolded
  // `data/sdk/` to `mkdir data/<table>` sends them to build a second store by accident.
  const dataRel = relative(root, dataRoot);

  for (const f of written) console.log(`  ✎ ${f}`);
  for (const f of skipped) console.log(`  · ${f} (exists — left alone)`);

  console.log(`\n  ${written.length} file(s) written, ${skipped.length} left alone.`);
  if (written.length > 0) {
    console.log("\nNext:");
    if (pack) {
      console.log("  1. Add a row to a generated table — copy its _template.md if it has one");
    } else {
      console.log(`  1. mkdir ${dataRel}/<table>, add a row (.md with frontmatter)`);
      console.log(`     then declare a view in ${dataRel}/_views/<id>.view.yml`);
    }
    // A store that is not the default one is only reachable by naming it, so the commands we hand
    // back have to carry the flag. Without it these two lines send the reader at `data/`, which
    // either is somebody else's store or does not exist — and the second line is destined for CI,
    // where getting it wrong is a check that passes by looking at the wrong thing.
    const at = data === null ? "" : ` --data ${dataRel}`;
    console.log(`  2. gitdata rollup${at}          # writes the view`);
    console.log(`  3. gitdata rollup${at} --check  # in CI: has anything drifted?`);
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

async function cmdRollup({ root, data, check, diff, json }) {
  const results = await rollup({ dataRoot: dataRootOf({ root, data }), repoRoot: root, check });

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

function cmdValidate({ root, data }) {
  const dataRoot = dataRootOf({ root, data });
  const { tables, issues } = validate({ dataRoot });

  if (tables.length === 0) {
    console.log(`  no schemas found — add ${relative(root, dataRoot)}/_schema/<table>.schema.yml`);
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

const MARK = { error: "✗", warn: "!", off: "·" };

/**
 * `doctor` — one report, one exit code, and a trailing block naming every check the consumer's
 * own policy lowered, with the reason they gave for lowering it. A divergence that is deliberate
 * stays visible and attributed; a divergence nobody explained is itself a finding (GD000).
 */
async function cmdDoctor({ root, data, check, strict, json, offline }) {
  const report = await doctor({ root, dataRoot: dataRootOf({ root, data }), offline });
  const status = exitCode(report.summary, { check, strict });

  if (json) {
    console.log(JSON.stringify({ ...report, exit: status }, null, 2));
    return status;
  }

  for (const f of report.findings) {
    console.log(`  ${MARK[f.level]} ${f.id}  ${(f.where ?? "").padEnd(34)} ${f.message}`);
  }
  if (report.findings.length === 0) console.log(`  · nothing to report across ${report.checked} check(s).`);

  // UNKNOWN is printed, never blanked: a check that could not run says so and names the gap.
  if (report.skipped.length > 0) {
    console.log("\n  not checked:");
    for (const s of report.skipped) console.log(`    ${s.id}  ${s.reason}`);
  }

  if (report.silenced.length > 0) {
    console.log("\n  silenced by policy:");
    for (const s of report.silenced) {
      const hits = s.findings === 0 ? "no findings" : `${s.findings} finding(s)`;
      console.log(`    ${s.id}  ${s.from} → ${s.level.padEnd(5)} ${hits.padEnd(14)} ${s.reason ?? "(no reason given)"}`);
    }
  }

  const { error, warn, off } = report.summary;
  console.log(`\n  ${error} error(s), ${warn} warning(s), ${off} silenced across ${report.checked} check(s).`);
  if (status === 0 && (check || strict)) console.log("  doctor passed.");
  if (status !== 0) console.log(`  doctor failed — ${strict ? "--strict counts warnings" : "--check counts errors"}.`);
  return status;
}

/** `stores` — the master table of contents across every trellis in a repo. Reports, never writes. */
function cmdStores({ root, json }) {
  const stores = describeStores(root);

  if (json) {
    console.log(JSON.stringify(stores, null, 2));
    return 0;
  }
  if (stores.length === 0) {
    console.log("  no stores found — a store is a directory holding a data/ trellis");
    return 0;
  }
  for (const store of stores) {
    const manifest = store.manifest ? `_gitdata.yml${store.engine ? ` · engine ${store.engine}` : ""}` : "no manifest";
    console.log(`${store.data}  (${manifest})`);
    for (const t of store.tables) {
      const rows = t.rows === null ? "declared, no directory" : `${t.rows} row${t.rows === 1 ? "" : "s"}`;
      console.log(`  ${t.name.padEnd(24)} ${String(t.class ?? "UNKNOWN").padEnd(10)} ${rows}`);
    }
    console.log("");
  }
  console.log(`  ${stores.length} store(s).`);
  return 0;
}

async function cmdEmitCodeowners({ root, data, check, out }) {
  const dataRoot = dataRootOf({ root, data });
  // Still keyed off --root, deliberately: a repo has one CODEOWNERS wherever its tables live, and
  // GitHub only reads it at .github/CODEOWNERS. --data moves what is described, never where the
  // description goes. Two stores emitting to one file is what --out is for.
  const outPath = resolve(root, out ?? ".github/CODEOWNERS");
  const result = emitCodeowners({ dataRoot, repoRoot: root, outPath, check });

  if (result.status === "empty") {
    console.log(`  no ownership declared — add ${relative(root, dataRoot)}/<table>/_owners.yml, then re-run`);
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

async function cmdTables({ root, data, json }) {
  const dataRoot = dataRootOf({ root, data });
  const tables = await describeTables(dataRoot);

  if (json) {
    console.log(JSON.stringify(tables, null, 2));
    return 0;
  }
  if (tables.length === 0) {
    console.log(`  no tables found — add ${relative(root, dataRoot)}/<table>/<row>.md`);
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

async function cmdQuery({ root, data, json, rest }) {
  const [sql] = rest;
  if (!sql) throw new Error('query requires a SQL statement, e.g. gitdata query "SELECT * FROM <table>"');
  const rows = await runQuery(dataRootOf({ root, data }), sql);

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
  if (args.command === "doctor") process.exit(await cmdDoctor(args));
  if (args.command === "stores") process.exit(cmdStores(args));
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
