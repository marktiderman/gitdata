/**
 * CLI contract tests — the exit codes ARE the product: `rollup --check` exiting non-zero is what
 * lets a consumer mark it a required check, and `--help` exiting zero is what lets a CI smoke
 * test tell a working install from a broken one. Spawned as real processes, like consumers do.
 *
 * Doubles as the end-to-end pack path: init → copy the template → rollup → drift both ways.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      assert.match(r.stdout, /gitdata tables/);
      assert.match(r.stdout, /gitdata query/);
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

describe("emit codeowners", () => {
  test("no _owners.yml → exit 0 and no file written; declared ownership → written, checked, drifted, missing", () => {
    const root = mkdtempSync(join(tmpdir(), "gitdata-cli-codeowners-"));
    try {
      const dataDir = join(root, "data", "things");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "T-001.md"), "---\nid: T-001\n---\nBody.\n");

      // No ownership declared yet: exit 0, no CODEOWNERS written.
      const empty = run(["emit", "codeowners", "--root", root]);
      assert.equal(empty.status, 0, empty.stderr);
      assert.match(empty.stdout, /no ownership declared/);
      assert.ok(!existsSync(join(root, ".github/CODEOWNERS")));

      // Declare ownership, write it.
      writeFileSync(join(dataDir, "_owners.yml"), 'owners: ["@team"]\n');
      const written = run(["emit", "codeowners", "--root", root]);
      assert.equal(written.status, 0, written.stderr);
      const codeowners = join(root, ".github/CODEOWNERS");
      assert.ok(existsSync(codeowners));
      assert.match(readFileSync(codeowners, "utf8"), /\/data\/things\/\*\* @team/);

      // Clean → exit 0.
      assert.equal(run(["emit", "codeowners", "--check", "--root", root]).status, 0);

      // Hand-edited → drifted, exit 1.
      writeFileSync(codeowners, readFileSync(codeowners, "utf8") + "\nvandalism\n");
      const drift = run(["emit", "codeowners", "--check", "--root", root]);
      assert.equal(drift.status, 1);
      assert.match(drift.stdout, /drifted/);

      // Deleted → missing, exit 1.
      rmSync(codeowners);
      const missing = run(["emit", "codeowners", "--check", "--root", root]);
      assert.equal(missing.status, 1);
      assert.match(missing.stdout, /missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    assert.match(r3.stdout, /0 file\(s\) written, 5 left alone/);
  });
});

describe("tables and query, spawned against a real fixture repo", () => {
  let tRoot;
  before(() => {
    tRoot = mkdtempSync(join(tmpdir(), "gitdata-cli-tables-"));
    mkdirSync(join(tRoot, "data/things"), { recursive: true });
    writeFileSync(join(tRoot, "data/things/a.md"), "---\nid: T-001\ntier: 1\n---\nA.\n");
    writeFileSync(join(tRoot, "data/things/b.md"), "---\nid: T-002\ntier: 2\n---\nB.\n");
  });
  after(() => rmSync(tRoot, { recursive: true, force: true }));

  test("tables: plain text lists every table with its columns and row count", () => {
    const r = run(["tables", "--root", tRoot]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /things \(2 rows\)/);
    assert.match(r.stdout, /id\s+text/);
    assert.match(r.stdout, /tier\s+integer/);
    assert.match(r.stdout, /_file\s+text/);
  });

  test("tables --json emits an agent-parseable array of {table, rows, columns}", () => {
    const r = run(["tables", "--root", tRoot, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    const things = parsed.find((t) => t.table === "things");
    assert.equal(things.rows, 2);
    // Sorted by column name — deterministic regardless of frontmatter key order or directory order.
    assert.deepEqual(
      things.columns.map((c) => c.name),
      ["_body", "_file", "id", "tier"],
    );
    assert.deepEqual(things.columns.find((c) => c.name === "tier"), { name: "tier", type: "integer" });
  });

  test("tables output is byte-identical across repeated runs", () => {
    const r1 = run(["tables", "--root", tRoot, "--json"]);
    const r2 = run(["tables", "--root", tRoot, "--json"]);
    assert.equal(r1.stdout, r2.stdout);
  });

  test("query: plain text prints a readable table and the row count", () => {
    const r = run(["query", "SELECT id, tier FROM things ORDER BY id", "--root", tRoot]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T-001/);
    assert.match(r.stdout, /T-002/);
    assert.match(r.stdout, /2 rows/);
  });

  test("query --json emits rows as an array of objects", () => {
    const r = run(["query", "SELECT id, tier FROM things ORDER BY id", "--root", tRoot, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [
      { id: "T-001", tier: 1 },
      { id: "T-002", tier: 2 },
    ]);
  });

  test("query works with --root given before the SQL argument", () => {
    const r = run(["query", "--root", tRoot, "SELECT COUNT(*) AS n FROM things"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1/);
  });

  test("query without a SQL argument fails loud and exits 1", () => {
    const r = run(["query", "--root", tRoot]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires a SQL statement/);
  });

  test("query rejects a mutating statement and exits non-zero, touching nothing", () => {
    const r = run(["query", "UPDATE things SET tier = 99", "--root", tRoot]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /read-only/);

    // Confirm nothing was mutated — read the same table back.
    const after = run(["query", "SELECT tier FROM things WHERE id = 'T-001'", "--root", tRoot, "--json"]);
    assert.deepEqual(JSON.parse(after.stdout), [{ tier: 1 }]);
  });

  test("query rejects multiple statements separated by ';'", () => {
    const r = run(["query", "SELECT 1; DROP TABLE things", "--root", tRoot]);
    assert.notEqual(r.status, 0);
  });
});
