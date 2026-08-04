/**
 * Engine tests, run against a self-contained fixture repo built in a temp dir — the package must
 * be testable without any consumer repo checked out next to it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseFrontmatter, FrontmatterError } from "../src/frontmatter.js";
import { isRowFile, load, rowFilesIn } from "../src/load.js";
import { project, query } from "../src/project.js";
import { renderTemplate, RenderError } from "../src/render.js";
import { rollup } from "../src/rollup.js";

let root;

function write(rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "gitdata-test-"));
  write("data/features/GEN-001--alpha.md", "---\nid: GEN-001\nparent: null\ntier: 1\n---\nAlpha body.\n");
  write("data/features/GEN-002--beta.md", "---\nid: GEN-002\nparent: GEN-001\ntier: 2\n---\nBeta body.\n");
  write("data/features/GEN-003--gamma.md", "---\nid: GEN-003\nparent: GEN-002\ntier: 3\n---\nGamma body.\n");
  write("data/features/_template.md", "---\nid: GEN-000\n---\nTemplate — must never load as a row.\n");
  write("data/features/README.md", "Docs, not a row.\n");
  write("data/empty/.gitkeep", "");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("frontmatter", () => {
  test("parses data and body, and accepts CRLF fences", () => {
    assert.deepEqual(parseFrontmatter("---\na: 1\n---\nbody\n").data, { a: 1 });
    assert.equal(parseFrontmatter("---\na: 1\n---\nbody\n").body, "body\n");
    assert.deepEqual(parseFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n").data, { a: 1 });
  });

  test("fails loud on a missing block or a non-mapping", () => {
    assert.throws(() => parseFrontmatter("no fence here"), FrontmatterError);
    assert.throws(() => parseFrontmatter("---\n- a\n- b\n---\n"), FrontmatterError);
  });
});

describe("load", () => {
  test("folder = table, file = row; templates and READMEs are not rows", () => {
    const tables = load(join(root, "data"));
    assert.deepEqual([...tables.keys()].sort(), ["empty", "features"]);
    assert.equal(tables.get("features").rows.length, 3);
    assert.equal(tables.get("empty").rows.length, 0);
  });

  test("isRowFile answers the same question the loader asks, for a consumer that writes rows", () => {
    // Pinned as behaviour because it is now published API: a consumer deletes and rewrites rows by
    // this predicate, so widening or narrowing it is a change to somebody else's data, not a
    // refactor. Each clause below is a file somebody has actually lost or duplicated.
    assert.ok(isRowFile("GEN-001--alpha.md"));
    assert.ok(!isRowFile("_template.md"), "`_` is the reservation for non-rows");
    assert.ok(!isRowFile("README.md"), "a table documents itself without becoming a row");
    assert.ok(!isRowFile("ReadMe.md"), "case-insensitively — the loader's docstring says so");
    assert.ok(!isRowFile("notes.txt"), "the format does not move: rows are markdown");
    assert.ok(!isRowFile("row.md.bak"), "an editor backup is not a row");
  });

  test("a sharded table keeps its nested rows, and does not become a table per shard", () => {
    // Reading only the top level dropped every sharded row with no error and no count. Sharding
    // by date is the ordinary way a table outgrows one directory, so the loss was silent and
    // waiting. `2026/` must not appear as a table of its own either.
    const shard = mkdtempSync(join(tmpdir(), "gitdata-shard-"));
    const put = (rel, text) => {
      mkdirSync(join(shard, rel, ".."), { recursive: true });
      writeFileSync(join(shard, rel), text, "utf8");
    };
    put("data/sessions/S-001--flat.md", "---\nid: S-001\n---\nFlat.\n");
    put("data/sessions/2026/01/S-002--jan.md", "---\nid: S-002\n---\nJanuary.\n");
    put("data/sessions/2026/02/S-003--feb.md", "---\nid: S-003\n---\nFebruary.\n");
    put("data/sessions/2026/01/_draft.md", "---\nid: S-XXX\n---\nDraft.\n");
    put("data/sessions/2026/_scratch/S-999--no.md", "---\nid: S-999\n---\nUnderscore dir.\n");
    put("data/sessions/2026/README.md", "Docs, not a row.\n");

    try {
      const tables = load(join(shard, "data"));
      assert.deepEqual([...tables.keys()], ["sessions"], "a shard directory became its own table");
      const rows = tables.get("sessions").rows;
      // Ordered by path relative to the table, so a compile never depends on directory order.
      assert.deepEqual(rows.map((r) => r.id), ["S-002", "S-003", "S-001"]);
      // `_file` locates the row inside the table, so two shards may hold same-named files.
      assert.deepEqual(rows.map((r) => r._file), [
        "2026/01/S-002--jan.md",
        "2026/02/S-003--feb.md",
        "S-001--flat.md",
      ]);
      // The exported walk is the one the loader uses, so a consumer enumerating a table for itself
      // cannot reach a different answer than the one that got loaded. A flat `readdirSync` here
      // returns one file out of three and calls the table complete.
      assert.deepEqual(
        rowFilesIn(join(shard, "data", "sessions")),
        rows.map((r) => r._file),
        "rowFilesIn disagreed with what load() read",
      );
    } finally {
      rmSync(shard, { recursive: true, force: true });
    }
  });
});

describe("project + query", () => {
  test("an empty table is queryable, not a missing-table error", async () => {
    const db = await project(load(join(root, "data")));
    assert.deepEqual(query(db, "SELECT COUNT(*) AS n FROM empty"), [{ n: 0 }]);
    db.close();
  });

  test("collapse_ws folds whitespace runs, matching the reference implementation", async () => {
    const db = await project(load(join(root, "data")));
    assert.equal(query(db, "SELECT collapse_ws('  a\n  b   c ') AS v")[0].v, "a b c");
    db.close();
  });

  test("WITH RECURSIVE walks a parent chain — the shape a hierarchy view needs", async () => {
    const db = await project(load(join(root, "data")));
    const rows = query(
      db,
      `WITH RECURSIVE t AS (
         SELECT id, parent, 0 AS depth FROM features WHERE parent IS NULL
         UNION ALL
         SELECT f.id, f.parent, t.depth + 1 FROM features f JOIN t ON f.parent = t.id)
       SELECT id, depth FROM t ORDER BY depth`,
    );
    assert.deepEqual(rows, [
      { id: "GEN-001", depth: 0 },
      { id: "GEN-002", depth: 1 },
      { id: "GEN-003", depth: 2 },
    ]);
    db.close();
  });

  test("body text is queryable — a view may derive a column from it", async () => {
    const db = await project(load(join(root, "data")));
    assert.equal(query(db, "SELECT _body AS b FROM features WHERE id = 'GEN-001'")[0].b, "Alpha body.\n");
    db.close();
  });

  test("md_section extracts a section, drops blanks and sub-headings, stops at the next ##", async () => {
    const db = await project(load(join(root, "data")));
    const body = "# Title\n\n## The job\nFirst line.\n\n### skip me\nSecond line.\n\n## Next\nNot this.\n";
    const one = (sql, ...args) => query(db, sql.replace(/\?/g, () => `'${args.shift()}'`))[0].v;

    assert.equal(one("SELECT md_section(?, 'The job') AS v", body.replace(/'/g, "''")), "First line. Second line.");
    // a heading that is not present yields empty, never null-propagating garbage
    assert.equal(one("SELECT md_section(?, 'Nope') AS v", body.replace(/'/g, "''")), "");
    db.close();
  });

  test("md_section reads a section that runs to the end of the file", async () => {
    // Regression: the first implementation anchored the section end with `\Z`, which does not
    // exist in JavaScript regex (it is Python's) and silently means a literal "Z". Sections
    // followed by another `##` worked; a section that ended the file returned "". Every file in the
    // corpus that first exercised this had a following section, so only a fresh repo exposed it.
    const db = await project(load(join(root, "data")));
    const body = "# Title\n\n## The job\nRuns to the very end.\n";
    const got = query(db, `SELECT md_section('${body.replace(/'/g, "''")}', 'The job') AS v`)[0].v;
    assert.equal(got, "Runs to the very end.");
    db.close();
  });

  test("natural_key sorts dotted ids numerically — 1.10 after 1.9, not after 1.1", async () => {
    const db = await project(load(join(root, "data")));
    const ordered = query(
      db,
      `SELECT c FROM (SELECT '1.2' AS c UNION ALL SELECT '1.10' UNION ALL SELECT '1.9'
                      UNION ALL SELECT '1.1' UNION ALL SELECT '1.x.idea')
       ORDER BY natural_key(c)`,
    ).map((r) => r.c);
    assert.deepEqual(ordered, ["1.1", "1.2", "1.9", "1.10", "1.x.idea"]);
    db.close();
  });
});

describe("render", () => {
  const results = { rows: [{ line: "one" }, { line: "two" }], count: [{ n: 2 }] };

  test("{{name}} joins rows, {{name.col}} reads a scalar", () => {
    assert.equal(renderTemplate("{{rows}}\ntotal={{count.n}}", results), "one\ntwo\ntotal=2");
  });

  test("unknown query or column fails loud rather than rendering empty", () => {
    assert.throws(() => renderTemplate("{{nope}}", results), RenderError);
    assert.throws(() => renderTemplate("{{count.missing}}", results), RenderError);
  });
});

describe("rollup", () => {
  before(() => {
    write(
      "data/_views/tiers.view.yml",
      [
        "kind: view-spec",
        "id: tiers",
        "out: data/_views/tiers.md",
        "queries:",
        "  rows: |",
        "    SELECT '- ' || id AS line FROM features ORDER BY id",
        "  total: |",
        "    SELECT COUNT(*) AS n FROM features",
        "template: |",
        "  # Tiers ({{total.n}})",
        "  {{rows}}",
        "",
      ].join("\n"),
    );
  });

  test("writes the artifact, then reports it unchanged on a second run", async () => {
    const first = await rollup({ dataRoot: join(root, "data"), repoRoot: root });
    assert.equal(first[0].status, "written");
    assert.equal(
      readFileSync(join(root, "data/_views/tiers.md"), "utf8"),
      "# Tiers (3)\n- GEN-001\n- GEN-002\n- GEN-003\n",
    );

    const second = await rollup({ dataRoot: join(root, "data"), repoRoot: root });
    assert.equal(second[0].status, "unchanged");
  });

  test("--check detects a hand-edited artifact without writing", async () => {
    writeFileSync(join(root, "data/_views/tiers.md"), "# Tiers (3)\nhand-edited\n", "utf8");
    const checked = await rollup({ dataRoot: join(root, "data"), repoRoot: root, check: true });
    assert.equal(checked[0].status, "drifted");
    // check must not repair the file — that is `rollup`'s job, not the check's
    assert.match(readFileSync(join(root, "data/_views/tiers.md"), "utf8"), /hand-edited/);
  });

  test("refuses to write outside the repo root", async () => {
    // A typo in `out:` would otherwise silently drop a file outside the project, and an installed
    // third-party pack could target something like ~/.bashrc. A rollup only writes artifacts
    // belonging to the repo it was pointed at.
    for (const out of ["../../ESCAPED.md", "/tmp/gitdata-should-not-exist.md"]) {
      const dir = mkdtempSync(join(tmpdir(), "gitdata-escape-"));
      mkdirSync(join(dir, "data/t"), { recursive: true });
      mkdirSync(join(dir, "data/_views"), { recursive: true });
      writeFileSync(join(dir, "data/t/a.md"), "---\nid: A\n---\nbody\n");
      writeFileSync(
        join(dir, "data/_views/x.view.yml"),
        `kind: view-spec\nid: x\nout: ${out}\nqueries:\n  r: |\n    SELECT id AS line FROM t\ntemplate: |\n  {{r}}\n`,
      );
      await assert.rejects(
        () => rollup({ dataRoot: join(dir, "data"), repoRoot: dir }),
        /escapes the repo root/,
      );
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(existsSync("/tmp/gitdata-should-not-exist.md"), false);
  });

  test("--check detects a source edit that was never rolled up", async () => {
    await rollup({ dataRoot: join(root, "data"), repoRoot: root });
    write("data/features/GEN-004--delta.md", "---\nid: GEN-004\nparent: GEN-003\ntier: 4\n---\nDelta.\n");
    const checked = await rollup({ dataRoot: join(root, "data"), repoRoot: root, check: true });
    assert.equal(checked[0].status, "drifted");
  });
});
