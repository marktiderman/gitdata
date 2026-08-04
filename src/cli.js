#!/usr/bin/env node
/**
 * gitdata — dependable, structured, organized docs as data in git.
 *
 * gitdata GUIDES; GitHub ENFORCES. Commands report and emit; they never block. `rollup --check`
 * exits non-zero so a consumer can mark it a required check in their own CI — that choice is
 * theirs, not ours.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { init, listPacks } from "./init.js";
import { rollup } from "./rollup.js";

const USAGE = `gitdata — docs as data in git

  gitdata init [--pack <name>] [--root <dir>]  scaffold data/ — bare, or from a pack
  gitdata rollup [--check] [--root <dir>]      regenerate views | report drift without writing
  gitdata packs                                list available packs

Options:
  --root <dir>   repo root (default: cwd). Data lives in <root>/data.
`;

function parseArgs(argv) {
  const args = { command: argv[0], check: argv.includes("--check"), root: process.cwd(), pack: null };
  for (const [flag, key] of [["--root", "root"], ["--pack", "pack"]]) {
    const i = argv.indexOf(flag);
    if (i === -1) continue;
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    args[key] = key === "root" ? resolve(argv[i + 1]) : argv[i + 1];
  }
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

async function cmdRollup({ root, check }) {
  const results = await rollup({ dataRoot: resolve(root, "data"), repoRoot: root, check });

  if (results.length === 0) {
    console.log("  no views found — add data/_views/<name>.view.yml");
    return 0;
  }

  for (const r of results) {
    const mark = { written: "✎", unchanged: "·", drifted: "✗", missing: "✗" }[r.status];
    console.log(`  ${mark} ${r.id.padEnd(24)} ${r.status.padEnd(10)} ${r.out}`);
  }

  const bad = results.filter((r) => r.status === "drifted" || r.status === "missing");
  if (check && bad.length > 0) {
    console.log(`\n  ${bad.length} view(s) out of date — run \`gitdata rollup\` and commit the result.`);
    return 1;
  }
  console.log(`\n  ${results.length} view(s) ${check ? "checked" : "rolled up"}.`);
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
  if (args.command === "packs") process.exit(cmdPacks());
  console.log(USAGE);
  process.exit(args.command ? 1 : 0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
