/**
 * Engine tests, run against a self-contained fixture repo built in a temp dir — the package must
 * be testable without Genesis checked out next to it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseFrontmatter, FrontmatterError } from "../src/frontmatter.js";
import { load } from "../src/load.js";
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

  test("WITH RECURSIVE walks a parent chain — the shape the territory view needs", async () => {
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

  test("body text is queryable — the territory view derives a column from it", async () => {
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
    // followed by another `##` worked; a section that ended the file returned "". Every Genesis
    // feature file happened to have a following section, so only a fresh repo exposed it.
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

  test("--check detects a source edit that was never rolled up", async () => {
    await rollup({ dataRoot: join(root, "data"), repoRoot: root });
    write("data/features/GEN-004--delta.md", "---\nid: GEN-004\nparent: GEN-003\ntier: 4\n---\nDelta.\n");
    const checked = await rollup({ dataRoot: join(root, "data"), repoRoot: root, check: true });
    assert.equal(checked[0].status, "drifted");
  });
});
