/**
 * Engine tests, run against a self-contained fixture repo built in a temp dir — the package must
 * be testable without any consumer repo checked out next to it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseFrontmatter, FrontmatterError } from "../src/frontmatter.js";
import { escapedRowFiles, isRowFile, load, LoadError, rowFilesIn } from "../src/load.js";
import { project, query } from "../src/project.js";
import { renderTemplate, RenderError } from "../src/render.js";
import { rollup } from "../src/rollup.js";
import { validate } from "../src/validate.js";

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
    assert.ok(!isRowFile("notes.txt"), "the format does not move: a row is markdown or YAML, nothing else");
    assert.ok(!isRowFile("row.md.bak"), "an editor backup is not a row");
    assert.ok(!isRowFile(".hidden.md"), "the walk skips `.` entries, so the predicate must too");
    assert.ok(!isRowFile(".DS_Store.md"), "no `.`-prefixed file is a row, whatever its extension");
  });

  test("isRowFile agrees with the loader about a `.`-prefixed file", () => {
    // Asserting the predicate alone would have passed while the loader skipped the file: the walk
    // filters `.` entries before the predicate is ever consulted, so the disagreement is invisible
    // until the predicate is handed out on its own. This compares the two against ONE directory
    // rather than trusting either in isolation.
    const dir = mkdtempSync(join(tmpdir(), "gitdata-dot-"));
    const put = (rel, text) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    };
    put("data/things/a.md", "---\nid: A\n---\nVisible.\n");
    put("data/things/.hidden.md", "---\nid: H\n---\nHidden.\n");

    try {
      assert.deepEqual(rowFilesIn(join(dir, "data/things")), ["a.md"]);
      assert.deepEqual(
        load(join(dir, "data"))
          .get("things")
          .rows.map((r) => r._file),
        ["a.md"],
        "loader and predicate must answer identically",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escapedRowFiles names the rows that do not live under the table", () => {
    // A rewriter deletes every path rowFilesIn reports. Through a symlinked shard that reaches
    // outside the table, and can reach outside the repo. rowFilesIn must keep reporting them --
    // the loader reads them, so omitting them would make the enumerator disagree with the loader
    // again -- so the fact is published alongside instead, and the consumer rules on it.
    const dir = mkdtempSync(join(tmpdir(), "gitdata-escape-"));
    const put = (rel, text) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    };
    put("data/things/here.md", "---\nid: A\n---\nInside.\n");
    put("elsewhere/gone.md", "---\nid: B\n---\nOutside the table.\n");
    symlinkSync(join(dir, "elsewhere"), join(dir, "data/things/shard"));

    try {
      const table = join(dir, "data/things");
      assert.deepEqual(
        rowFilesIn(table),
        ["here.md", "shard/gone.md"],
        "the escaping row is still a row: the loader reads it, so the enumerator reports it",
      );
      assert.deepEqual(
        load(join(dir, "data")).get("things").rows.map((r) => r._file),
        ["here.md", "shard/gone.md"],
        "loader and enumerator still agree -- containment is a separate question",
      );
      assert.deepEqual(
        escapedRowFiles(table),
        ["shard/gone.md"],
        "and exactly the escaping one is named",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escapedRowFiles is empty for an ordinary table, nested or flat", () => {
    // The common case must cost the caller nothing to check, or nobody will check it.
    const dir = mkdtempSync(join(tmpdir(), "gitdata-contained-"));
    const put = (rel, text) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    };
    put("data/things/flat.md", "---\nid: A\n---\n");
    put("data/things/2026/01/nested.md", "---\nid: B\n---\n");

    try {
      const table = join(dir, "data/things");
      assert.deepEqual(rowFilesIn(table), ["2026/01/nested.md", "flat.md"]);
      assert.deepEqual(escapedRowFiles(table), [], "a nested shard on disk is not an escape");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * A row may be a whole-document `.yml` file as readily as a `.md` one. The frontmatter of a `.md`
 * row IS a YAML document; a store whose rows carry no prose was made to keep three lines of fence
 * around it, and the alternative — rename them to `.yml` — made every row invisible to the loader
 * with no error and no count. A validation gate then passes having read nothing, which is the
 * failure mode this project exists to prevent.
 */
describe("yaml rows", () => {
  /** A fixture store, torn down by the caller. */
  const store = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return {
      dir,
      put(rel, text) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), text, "utf8");
      },
      rm: () => rmSync(dir, { recursive: true, force: true }),
    };
  };

  test("a .yml row loads into the same shape a .md row does, with an empty body", () => {
    // The document IS the columns — there is no fence and nothing after it. `_body` is "" rather
    // than undefined so a view that reads a body off a mixed table gets a string from every row,
    // not a null from half of them.
    const s = store("gitdata-yaml-");
    s.put("data/things/T-001--md.md", "---\nid: T-001\ntitle: From markdown\n---\nProse.\n");
    s.put("data/things/T-002--yml.yml", "id: T-002\ntitle: From yaml\ntags: [a, b]\n");

    try {
      const rows = load(join(s.dir, "data")).get("things").rows;
      assert.deepEqual(rows.map((r) => r.id), ["T-001", "T-002"]);
      assert.deepEqual(rows.map((r) => r._file), ["T-001--md.md", "T-002--yml.yml"]);
      const yaml = rows[1];
      assert.equal(yaml.title, "From yaml");
      assert.deepEqual(yaml.tags, ["a", "b"]);
      assert.equal(yaml._body, "", "a .yml row has no body — the document is the whole row");
    } finally {
      s.rm();
    }
  });

  test("a .yml row is queryable beside a .md row, body included", async () => {
    // Both formats land in one table, so a view cannot tell them apart — which is the point.
    const s = store("gitdata-yaml-sql-");
    s.put("data/things/a.md", "---\nid: A\n---\nBody text.\n");
    s.put("data/things/b.yml", "id: B\n");

    try {
      const db = await project(load(join(s.dir, "data")));
      assert.deepEqual(query(db, "SELECT id, _body AS b FROM things ORDER BY id"), [
        { id: "A", b: "Body text.\n" },
        { id: "B", b: "" },
      ]);
      // md_section over an empty body answers "no such section", not a crash or a null.
      assert.equal(query(db, "SELECT md_section(_body, 'Any') AS v FROM things WHERE id = 'B'")[0].v, "");
      db.close();
    } finally {
      s.rm();
    }
  });

  test("the non-row reservations apply to .yml exactly as they do to .md", () => {
    // Each clause is a file somebody keeps beside their rows on purpose. `_owners.yml` is the one
    // this repo itself writes into a table directory: widening the extension without carrying the
    // `_` clause across would have loaded every ownership declaration as a row.
    assert.ok(isRowFile("T-001--thing.yml"));
    assert.ok(!isRowFile("_template.yml"), "`_` is the reservation for non-rows, whatever the extension");
    assert.ok(!isRowFile("_owners.yml"), "the file `emit codeowners` reads is not data");
    assert.ok(!isRowFile("readme.yml"));
    assert.ok(!isRowFile("ReadMe.yml"), "case-insensitively, exactly like README.md");
    assert.ok(!isRowFile(".hidden.yml"), "the walk skips `.` entries, so the predicate must too");
    assert.ok(!isRowFile("row.yml.bak"), "an editor backup is not a row");
    assert.ok(!isRowFile("notes.yaml"), "the accepted spelling is `.yml` — one spelling, or two files claim one row");
  });

  test("the loader and the enumerator agree about every .yml exclusion, against one directory", () => {
    // Asserting the predicate alone would pass while the loader read the file anyway: the two
    // answers only have to be compared against the same directory to catch a walk that widened
    // and a predicate that did not, or the reverse.
    const s = store("gitdata-yaml-excl-");
    s.put("data/things/keep.yml", "id: KEEP\n");
    s.put("data/things/_template.yml", "id: TEMPLATE\n");
    s.put("data/things/_owners.yml", "owners: ['@someone']\n");
    s.put("data/things/.hidden.yml", "id: HIDDEN\n");
    s.put("data/things/readme.yml", "id: README\n");
    s.put("data/things/notes.yaml", "id: NOTES\n");

    try {
      const table = join(s.dir, "data", "things");
      assert.deepEqual(rowFilesIn(table), ["keep.yml"]);
      assert.deepEqual(
        load(join(s.dir, "data")).get("things").rows.map((r) => r._file),
        ["keep.yml"],
        "loader and predicate must answer identically",
      );
    } finally {
      s.rm();
    }
  });

  test("a sharded table finds its nested .yml rows, and mixes them with .md in one order", () => {
    // The walk, not just the predicate. A consumer holding a widened predicate and its own flat
    // `readdirSync` finds none of these — the second half of the contract `rowFilesIn` publishes.
    const s = store("gitdata-yaml-shard-");
    s.put("data/sessions/S-001--flat.yml", "id: S-001\n");
    s.put("data/sessions/2026/01/S-002--jan.yml", "id: S-002\n");
    s.put("data/sessions/2026/02/S-003--feb.md", "---\nid: S-003\n---\nFeb.\n");
    s.put("data/sessions/2026/01/_draft.yml", "id: S-XXX\n");
    s.put("data/sessions/2026/_scratch/S-999--no.yml", "id: S-999\n");
    s.put("data/sessions/2026/readme.yml", "id: S-README\n");

    try {
      const rows = load(join(s.dir, "data")).get("sessions").rows;
      assert.deepEqual(rows.map((r) => r._file), [
        "2026/01/S-002--jan.yml",
        "2026/02/S-003--feb.md",
        "S-001--flat.yml",
      ]);
      assert.deepEqual(
        rowFilesIn(join(s.dir, "data", "sessions")),
        rows.map((r) => r._file),
        "rowFilesIn disagreed with what load() read",
      );
    } finally {
      s.rm();
    }
  });

  test("`foo.md` and `foo.yml` in one table is a loud error naming both paths", () => {
    // Two files, one row id. Picking either silently is a coin flip over which contract is live —
    // and the loser keeps being edited by someone who believes it is the row.
    const s = store("gitdata-yaml-clash-");
    s.put("data/things/F-001--thing.md", "---\nid: F-001\n---\nProse.\n");
    s.put("data/things/F-001--thing.yml", "id: F-001\n");

    try {
      const table = join(s.dir, "data", "things");
      for (const [what, run] of [
        ["load", () => load(join(s.dir, "data"))],
        ["rowFilesIn", () => rowFilesIn(table)],
        ["escapedRowFiles", () => escapedRowFiles(table)],
      ]) {
        assert.throws(
          run,
          (err) => {
            assert.ok(err instanceof LoadError, `${what} threw ${err.constructor.name}, not LoadError`);
            assert.match(err.message, /F-001--thing\.md/, `${what} did not name the .md file`);
            assert.match(err.message, /F-001--thing\.yml/, `${what} did not name the .yml file`);
            return true;
          },
          `${what} accepted two files claiming one row`,
        );
      }
    } finally {
      s.rm();
    }
  });

  test("the collision rule is about one row, not one basename in two shards", () => {
    // `2026/01/x.yml` and `2026/02/x.md` are two rows: `_file` is the id, and it differs. A
    // collision check keyed on the basename alone would refuse a legitimately sharded table.
    const s = store("gitdata-yaml-shardclash-");
    s.put("data/sessions/2026/01/x.yml", "id: JAN\n");
    s.put("data/sessions/2026/02/x.md", "---\nid: FEB\n---\n");

    try {
      assert.deepEqual(
        load(join(s.dir, "data")).get("sessions").rows.map((r) => r.id),
        ["JAN", "FEB"],
      );
    } finally {
      s.rm();
    }
  });

  test("a .yml row is checked by its table's schema exactly like a .md row", () => {
    // The gate is the point of the change: a store that moves its rows to `.yml` and keeps
    // `gitdata validate` in CI must keep being told when a row breaks its contract. Before the
    // loader read them, this reported zero issues over zero rows — a green gate that read nothing.
    const s = store("gitdata-yaml-validate-");
    s.put(
      "data/_schema/things.schema.yml",
      "kind: table-schema\nrequired: [id, title]\nunique: [id]\nenum:\n  status: [idea, shipped]\n",
    );
    s.put("data/things/good.yml", "id: T-001\ntitle: Fine\nstatus: shipped\n");
    s.put("data/things/bad.yml", "id: T-001\nstatus: nonsense\n");

    try {
      const { tables, issues } = validate({ dataRoot: join(s.dir, "data") });
      assert.deepEqual(tables, ["things"]);
      assert.deepEqual(
        [...load(join(s.dir, "data")).keys()],
        ["things"],
        "`_schema/` stays reserved: widening the extension must not turn schema files into rows",
      );
      const at = (rule) => issues.filter((i) => i.rule === rule).map((i) => i.file).sort();
      assert.deepEqual(at("required"), ["bad.yml"], "a missing required column in a .yml row");
      assert.deepEqual(at("unique"), ["bad.yml", "good.yml"], "both rows sharing an id are named");
      assert.deepEqual(at("enum"), ["bad.yml"], "a value outside the declared set");
    } finally {
      s.rm();
    }
  });

  test("a .yml row that is not a mapping, or will not parse, fails loud naming the file", () => {
    // Same contract a fence-less `.md` row gets: the loader never invents columns for a file it
    // could not read as a mapping.
    const s = store("gitdata-yaml-bad-");
    s.put("data/things/list.yml", "- a\n- b\n");
    try {
      assert.throws(() => load(join(s.dir, "data")), (err) => {
        assert.match(err.message, /things\/list\.yml/);
        return true;
      });
    } finally {
      s.rm();
    }

    const t = store("gitdata-yaml-fenced-");
    // The migration mistake: rename a `.md` row and keep its fences. YAML reads that as two
    // documents, so the error must say what a `.yml` row actually is instead of naming a parser.
    t.put("data/things/fenced.yml", "---\nid: T-001\n---\nProse.\n");
    try {
      assert.throws(() => load(join(t.dir, "data")), (err) => {
        assert.match(err.message, /things\/fenced\.yml/);
        assert.match(err.message, /fence/i, "the error must name the fix, not just the parser's complaint");
        return true;
      });
    } finally {
      t.rm();
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
