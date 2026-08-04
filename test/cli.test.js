/**
 * CLI contract tests — the exit codes ARE the product: `rollup --check` exiting non-zero is what
 * lets a consumer mark it a required check, and `--help` exiting zero is what lets a CI smoke
 * test tell a working install from a broken one. Spawned as real processes, like consumers do.
 *
 * Doubles as the end-to-end pack path: init → copy the template → rollup → drift both ways.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "gitdata-cli-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("cli conventions", () => {
  test("--help and -h print usage and exit 0", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run([flag]);
      assert.equal(r.status, 0, `${flag} exited ${r.status}`);
      assert.match(r.stdout, /gitdata init/);
    }
  });

  test("--version prints the package version and exits 0", () => {
    const r = run(["--version"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), PKG.version);
  });

  test("an unknown command prints usage and exits 1; bare invocation exits 0", () => {
    assert.equal(run(["frobnicate"]).status, 1);
    assert.equal(run([]).status, 0);
  });
});

describe("pack quickstart, end to end", () => {
  test("init → row → rollup → check clean → hand-edit drifts → delete goes missing", () => {
    const r1 = run(["init", "--pack", "feature-management", "--root", root]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(join(root, "data/features/_template.md")));

    // The documented step: copy the template to a real row.
    copyFileSync(join(root, "data/features/_template.md"), join(root, "data/features/F-001--first.md"));

    const r2 = run(["rollup", "--root", root]);
    assert.equal(r2.status, 0, r2.stderr);
    const board = join(root, "data/_views/features-board.md");
    const bytes = readFileSync(board, "utf8");
    assert.match(bytes, /^<!-- DERIVED VIEW/);
    assert.match(bytes, /# Features/);
    assert.match(bytes, /1 features/);

    // Clean → exit 0. Byte-identical on a second rollup (determinism, observed not assumed).
    assert.equal(run(["rollup", "--check", "--root", root]).status, 0);
    run(["rollup", "--root", root]);
    assert.equal(readFileSync(board, "utf8"), bytes);

    // Hand-edited artifact → drifted, exit 1.
    writeFileSync(board, bytes + "\nvandalism\n");
    const drift = run(["rollup", "--check", "--root", root]);
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /drifted/);

    // Deleted artifact → missing, exit 1.
    rmSync(board);
    const missing = run(["rollup", "--check", "--root", root]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /missing/);

    // Re-init accounts for every file: nothing rewritten, nothing lost from the books.
    const r3 = run(["init", "--pack", "feature-management", "--root", root]);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /0 file\(s\) written, 4 left alone/);
  });
});
