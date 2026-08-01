#!/usr/bin/env node
/**
 * gitdata — dependable, structured, organized docs as data in git.
 *
 * gitdata GUIDES; GitHub ENFORCES. Commands report and emit; they never block. `rollup --check`
 * exits non-zero so a consumer can mark it a required check in their own CI — that choice is
 * theirs, not ours.
 */
import { resolve } from "node:path";

import { rollup } from "./rollup.js";

const USAGE = `gitdata — docs as data in git

  gitdata rollup [--check] [--root <dir>]   regenerate views | report drift without writing

Options:
  --root <dir>   repo root (default: cwd). Data is read from <root>/data.
`;

function parseArgs(argv) {
  const args = { command: argv[0], check: argv.includes("--check"), root: process.cwd() };
  const i = argv.indexOf("--root");
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error("--root requires a directory");
    args.root = resolve(argv[i + 1]);
  }
  return args;
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

const args = parseArgs(process.argv.slice(2));
try {
  if (args.command === "rollup") process.exit(await cmdRollup(args));
  console.log(USAGE);
  process.exit(args.command ? 1 : 0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
