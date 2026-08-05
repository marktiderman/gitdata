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

/**
 * `--data <dir>` — the second store.
 *
 * `<root>/data` is the right default and stays the default. It stops being expressible the moment
 * a repo needs TWO stores: hand-authored rows and a machine-owned table set that an extractor
 * rewrites wholesale must not share a root, because one `rollup` regenerating both is wrong. The
 * only way to say that before was `--root data/sdk`, which puts the tables at `data/sdk/data/` and
 * tells every other part of the tool the repo root is somewhere it is not.
 *
 * Every test below asserts BOTH halves — what `--data` reads, and that `--root` alone still reads
 * exactly what it read before. A flag honoured by `validate` and not by `rollup` would be worse
 * than no flag: the two commands would disagree about what the data is, each correct about a
 * different directory, and nothing would report the disagreement.
 */
describe("--data, a second store beside the default one", () => {
  let dRoot;

  before(() => {
    dRoot = mkdtempSync(join(tmpdir(), "gitdata-cli-data-"));
    const put = (rel, text) => {
      mkdirSync(join(dRoot, rel, ".."), { recursive: true });
      writeFileSync(join(dRoot, rel), text, "utf8");
    };

    // The store a repo already has: hand-authored rows, with its own view, schema and owners.
    put("data/agents/A-1--scout.md", "---\nid: A-1\nrole: scout\n---\nHand-authored.\n");
    put("data/agents/_owners.yml", 'owners: ["@authors"]\n');
    put("data/_schema/agents.schema.yml", "required: [id, role]\n");
    put(
      "data/_views/agents.view.yml",
      "kind: view-spec\nid: agents\nout: data/_views/agents.md\n" +
        "queries:\n  rows: |\n    SELECT '- ' || id AS line FROM agents ORDER BY id\ntemplate: |\n  # Agents\n  {{rows}}\n",
    );

    // The machine-owned one beside it. Its table name exists in neither store's counterpart, so a
    // command that reads the wrong root fails to find the table rather than quietly reporting on
    // the wrong rows — the assertion can tell "read the other store" from "read nothing".
    put("data/sdk/envelopes/GAME_OVER.md", "---\nid: GAME_OVER\ndirection: out\n---\nEmitted by the game.\n");
    put("data/sdk/envelopes/SET_SESSION.md", "---\nid: SET_SESSION\ndirection: in\n---\nSent to the game.\n");
    put("data/sdk/envelopes/_owners.yml", 'owners: ["@wire"]\n');
    put("data/sdk/_schema/envelopes.schema.yml", "required: [id, direction]\nunique: [id]\n");
    put(
      "data/sdk/_views/wire.view.yml",
      "kind: view-spec\nid: wire\nout: data/sdk/_views/wire.md\n" +
        "queries:\n  rows: |\n    SELECT '- ' || id AS line FROM envelopes ORDER BY id\ntemplate: |\n  # Wire\n  {{rows}}\n",
    );
  });

  after(() => rmSync(dRoot, { recursive: true, force: true }));

  test("tables reads the store --data names, and --root alone reads the default one", () => {
    const named = run(["tables", "--root", dRoot, "--data", "data/sdk", "--json"]);
    assert.equal(named.status, 0, named.stderr);
    assert.deepEqual(
      JSON.parse(named.stdout).map((t) => t.table),
      ["envelopes"],
      "--data must project the tables under it, not the ones under <root>/data",
    );

    const dflt = run(["tables", "--root", dRoot, "--json"]);
    assert.equal(dflt.status, 0, dflt.stderr);
    assert.ok(
      JSON.parse(dflt.stdout).some((t) => t.table === "agents"),
      "--root alone must still read <root>/data",
    );
  });

  test("query runs against the store --data names", () => {
    const r = run(["query", "SELECT id FROM envelopes ORDER BY id", "--root", dRoot, "--data", "data/sdk", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [{ id: "GAME_OVER" }, { id: "SET_SESSION" }]);

    // Without the flag the table is not there at all — proof the projection came from `data/sdk`
    // and not from a default root that happened to contain the same rows.
    assert.notEqual(run(["query", "SELECT id FROM envelopes", "--root", dRoot]).status, 0);
  });

  test("rollup compiles the views of the store --data names, and leaves the other store's alone", () => {
    const r = run(["rollup", "--root", dRoot, "--data", "data/sdk"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dRoot, "data/sdk/_views/wire.md"), "utf8"), "# Wire\n- GAME_OVER\n- SET_SESSION\n");
    assert.ok(
      !existsSync(join(dRoot, "data/_views/agents.md")),
      "rolling up one store must not regenerate the other — that is the whole reason the roots are separate",
    );

    // And the default root still finds its own view, unchanged by the flag existing.
    assert.equal(run(["rollup", "--root", dRoot]).status, 0);
    assert.equal(readFileSync(join(dRoot, "data/_views/agents.md"), "utf8"), "# Agents\n- A-1\n");

    // --check follows --data too, or CI would green-light a store nobody compiled.
    assert.equal(run(["rollup", "--check", "--root", dRoot, "--data", "data/sdk"]).status, 0);
    writeFileSync(join(dRoot, "data/sdk/_views/wire.md"), "# Wire\nhand-edited\n", "utf8");
    const drift = run(["rollup", "--check", "--root", dRoot, "--data", "data/sdk"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /drifted/);
    run(["rollup", "--root", dRoot, "--data", "data/sdk"]); // leave the fixture clean for later tests
  });

  test("validate checks the schemas of the store --data names", () => {
    const clean = run(["validate", "--root", dRoot, "--data", "data/sdk"]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /1 table\(s\) checked, 0 issues/);

    // A row that breaks only the second store's schema must be reported only when that store is
    // the one being validated — otherwise the flag is decorative and CI checks the wrong contract.
    const bad = join(dRoot, "data/sdk/envelopes/BROKEN.md");
    writeFileSync(bad, "---\nid: BROKEN\n---\nNo direction.\n", "utf8");
    try {
      const r = run(["validate", "--root", dRoot, "--data", "data/sdk"]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /missing "direction"/);
      assert.equal(run(["validate", "--root", dRoot]).status, 0, "the default store is still valid, and untouched");
    } finally {
      rmSync(bad);
    }
  });

  test("emit codeowners describes the store --data names, and still writes where --root says", () => {
    // The two flags own different halves: --data is WHAT is described, --root is WHERE the
    // description goes and what its patterns are anchored to. GitHub reads one CODEOWNERS per
    // repo, so a second store emits through --out rather than moving the file.
    const out = join(dRoot, ".github/CODEOWNERS-sdk");
    const r = run(["emit", "codeowners", "--root", dRoot, "--data", "data/sdk", "--out", ".github/CODEOWNERS-sdk"]);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(out, "utf8");
    assert.match(text, /^\/data\/sdk\/envelopes\/\*\* @wire$/m, "patterns stay relative to --root, not to --data");
    assert.match(text, /from data\/sdk\/<table>\/_owners\.yml/, "the header names the store it actually read");
    assert.ok(!text.includes("@authors"), "the other store's ownership must not leak in");

    const dflt = run(["emit", "codeowners", "--root", dRoot]);
    assert.equal(dflt.status, 0, dflt.stderr);
    const dfltText = readFileSync(join(dRoot, ".github/CODEOWNERS"), "utf8");
    assert.match(dfltText, /^\/data\/agents\/\*\* @authors$/m);
    assert.match(dfltText, /from data\/<table>\/_owners\.yml/, "the default root's header is unchanged, byte for byte");
    assert.ok(!dfltText.includes("@wire"));
  });

  test("init scaffolds the root --data names, and leaves an existing default store alone", () => {
    const root = mkdtempSync(join(tmpdir(), "gitdata-cli-data-init-"));
    try {
      mkdirSync(join(root, "data/agents"), { recursive: true });
      writeFileSync(join(root, "data/agents/A-1.md"), "---\nid: A-1\n---\nAlready here.\n");

      const r = run(["init", "--root", root, "--data", "data/sdk"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(root, "data/sdk/README.md")));
      assert.ok(existsSync(join(root, "data/sdk/_views/.gitkeep")));
      assert.ok(!existsSync(join(root, "data/README.md")), "the default root must not be scaffolded behind the flag");

      // The scaffolded README and the printed next steps are instructions someone will follow. A
      // hardcoded `data/` there sends the reader to put their first row in the other store.
      assert.match(readFileSync(join(root, "data/sdk/README.md"), "utf8"), /mkdir -p data\/sdk\/things/);
      assert.match(r.stdout, /gitdata rollup --data data\/sdk/);

      // Idempotent for the named root, exactly as it is for the default one.
      const again = run(["init", "--root", root, "--data", "data/sdk"]);
      assert.match(again.stdout, /0 file\(s\) written, 2 left alone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init --pack refuses a different data root rather than installing a half-wired pack", () => {
    // A pack's files/ tree is copied verbatim, and its paths, prose and view `out:` all say
    // `data/`. Copying it under another root would leave the tables in one place and the view
    // writing its artifact in another, and two packs installed at two roots would declare the
    // same `out:` and silently overwrite each other. Refusing names the constraint; installing
    // would not.
    const root = mkdtempSync(join(tmpdir(), "gitdata-cli-data-pack-"));
    try {
      const r = run(["init", "--pack", "feature-management", "--root", root, "--data", "data/sdk"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /pack installs into <root>\/data/);
      assert.ok(!existsSync(join(root, "data/sdk")), "a refused install must leave nothing behind");
      assert.ok(!existsSync(join(root, "data/features")), "and must not fall back to the default root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--data must name a directory inside --root", () => {
    // Not a trust boundary — it is about what the other consumers of --root would then emit.
    // `emit codeowners` anchors its patterns at the data root's path relative to the repo, so a
    // root-equal data dir renders `/**` (a rule owning the whole repo) and an outside one renders
    // `/../elsewhere/**`, which GitHub does not honour and no reader can act on.
    for (const [data, expected] of [
      ["/etc", /not under/],
      ["..", /not under/],
      [".", /not --root itself/],
    ]) {
      const r = run(["tables", "--root", dRoot, "--data", data]);
      assert.equal(r.status, 1, `--data ${data} was accepted`);
      assert.match(r.stderr, expected);
    }
  });

  test("a `_`-prefixed second store is invisible to the first; an ordinary one is a table of it", () => {
    // Worth pinning because it decides where a consumer should put the second store, and the
    // answer is not obvious. `--data` sets which root is read; it does not hide that root from
    // whoever reads the other one. The loader's existing `_` reservation is what does that, and it
    // is the difference between two independent stores and one store nested inside another's rows.
    const root = mkdtempSync(join(tmpdir(), "gitdata-cli-data-nesting-"));
    const put = (rel, text) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text, "utf8");
    };
    try {
      put("data/agents/A-1.md", "---\nid: A-1\n---\nHand-authored.\n");
      put("data/plain/envelopes/E-1.md", "---\nid: E-1\n---\nNested, unprefixed.\n");
      put("data/_hidden/envelopes/E-2.md", "---\nid: E-2\n---\nNested, reserved.\n");

      const tables = JSON.parse(run(["tables", "--root", root, "--json"]).stdout).map((t) => t.table);
      assert.deepEqual(tables, ["agents", "plain"], "`_hidden` is not a table of the outer store; `plain` is");

      // Both are still readable as stores in their own right — that is what --data is for.
      for (const dir of ["data/plain", "data/_hidden"]) {
        const r = run(["tables", "--root", root, "--data", dir, "--json"]);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout).map((t) => t.table), ["envelopes"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
