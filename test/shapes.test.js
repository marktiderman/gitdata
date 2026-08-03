/**
 * Shape-dispatch and `tree` tests.
 *
 * Before dispatch existed, `src/shapes/` was unreachable from a view spec — these tests exist so
 * that cannot silently regress. Each builds its own fixture repo in a temp dir.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { init } from "../src/init.js";
import { load } from "../src/load.js";
import { project } from "../src/project.js";
import { rollup } from "../src/rollup.js";
import { runShape, ShapeError } from "../src/shapes/index.js";
import { tree } from "../src/shapes/tree.js";

let root;

function write(rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** A node table: a two-deep spine, one dangling parent, and a two-row cycle. */
before(() => {
  root = mkdtempSync(join(tmpdir(), "gitdata-shapes-"));
  write("data/nodes/a.md", "---\nid: a\ntitle: A\nparent: null\n---\n");
  write("data/nodes/b.md", "---\nid: b\ntitle: B\nparent: a\n---\n");
  write("data/nodes/c.md", "---\nid: c\ntitle: C\nparent: b\n---\n");
  write("data/nodes/ghost.md", "---\nid: ghost\ntitle: Ghost\nparent: nowhere\n---\n");
  write("data/nodes/loop1.md", "---\nid: loop1\ntitle: Loop1\nparent: loop2\n---\n");
  write("data/nodes/loop2.md", "---\nid: loop2\ntitle: Loop2\nparent: loop1\n---\n");
  write("data/clean/x.md", "---\nid: x\ntitle: X\nparent: null\n---\n");
  write("data/clean/y.md", "---\nid: y\ntitle: Y\nparent: x\n---\n");
  // Two rows sharing an id, under both the default `id` column and a custom one.
  write("data/dupes/one.md", "---\nid: a\ncode: x\ntitle: First\nparent: null\n---\n");
  write("data/dupes/two.md", "---\nid: a\ncode: x\ntitle: Second\nparent: null\n---\n");
});

after(() => rmSync(root, { recursive: true, force: true }));

const withDb = async (fn) => {
  const db = await project(load(join(root, "data")));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const treeSpec = (over = {}) => ({
  from: "nodes",
  line: ["- ", { from: "title" }],
  order: { by: "id" },
  ...over,
});

describe("tree shape", () => {
  test("nests children under parents and indents by depth", async () => {
    const lines = await withDb((db) => tree(db, treeSpec()));
    assert.equal(lines[0], "- A");
    assert.equal(lines[1], "  - B");
    assert.equal(lines[2], "    - C");
  });

  test("reports a dangling parent as an orphan, naming the missing id", async () => {
    const lines = await withDb((db) => tree(db, treeSpec()));
    const ghost = lines.find((l) => l.includes("Ghost"));
    assert.match(ghost, /parent "nowhere" not found/);
  });

  test("reports cycle members as unreachable rather than dropping them", async () => {
    // The failure this guards: classifying orphans as "parent does not resolve" would place both
    // cycle rows nowhere and emit neither — a silent loss of real rows.
    const lines = await withDb((db) => tree(db, treeSpec()));
    assert.ok(lines.some((l) => l.includes("Loop1") && l.includes("unreachable (cycle)")));
    assert.ok(lines.some((l) => l.includes("Loop2") && l.includes("unreachable (cycle)")));
  });

  test("emits every row exactly once", async () => {
    const lines = await withDb((db) => tree(db, treeSpec()));
    assert.equal(lines.length, 6);
  });

  test("omits the orphan heading when nothing failed to place", async () => {
    const lines = await withDb((db) =>
      tree(db, { from: "clean", line: ["- ", { from: "title" }], orphans: { heading: "## Orphans" } }),
    );
    assert.deepEqual(lines, ["- X", "  - Y"]);
  });

  test("omits the reason comment on orphan lines when `bare` is set", async () => {
    const lines = await withDb((db) => tree(db, treeSpec({ orphans: { bare: true } })));
    const ghost = lines.find((l) => l.includes("Ghost"));
    assert.equal(ghost, "- Ghost");
  });

  test("refuses duplicate ids rather than silently dropping a row", async () => {
    // Tables carry no PRIMARY KEY and frontmatter enforces nothing, so two rows can share an id.
    // Before this check the second was skipped by `seen` during the walk AND excluded from the
    // orphan sweep for the same reason — it produced no output at all.
    await withDb((db) => {
      assert.throws(
        () => tree(db, { from: "dupes", line: ["- ", { from: "title" }] }),
        /duplicate id "a"/,
      );
      // Same defect via a custom id column.
      assert.throws(
        () => tree(db, { from: "dupes", id: "code", line: ["- ", { from: "title" }] }),
        /duplicate code "x"/,
      );
    });
  });

  test("honours a custom indent", async () => {
    const lines = await withDb((db) => tree(db, treeSpec({ indent: "> " })));
    assert.equal(lines[1], "> - B");
  });

  test("refuses a spec with no `from` or no `line`", async () => {
    await withDb((db) => {
      assert.throws(() => tree(db, { line: [] }), ShapeError);
      assert.throws(() => tree(db, { from: "nodes" }), ShapeError);
    });
  });
});

describe("shape dispatch", () => {
  test("runs a shape and returns renderer-shaped rows", async () => {
    const rows = await withDb((db) => runShape(db, { shape: "tree", ...treeSpec({ from: "clean" }) }));
    assert.deepEqual(rows, [{ line: "- X" }, { line: "  - Y" }]);
  });

  test("names the available shapes when one is unknown or missing", async () => {
    await withDb((db) => {
      assert.throws(() => runShape(db, { shape: "nope" }), /unknown shape "nope"/);
      assert.throws(() => runShape(db, {}), /needs a "shape"/);
    });
  });

  test("a view may mix a shape and raw SQL", async () => {
    write(
      "data/_views/mixed.view.yml",
      [
        "kind: view-spec",
        "id: mixed",
        "out: data/_views/mixed.md",
        "queries:",
        "  total: |",
        "    SELECT COUNT(*) AS n FROM clean",
        "  body:",
        "    shape: tree",
        "    from: clean",
        '    line: ["- ", { from: title }]',
        "template: |",
        "  {{total.n}} rows",
        "  {{body}}",
        "",
      ].join("\n"),
    );
    const [result] = await rollup({ dataRoot: join(root, "data"), repoRoot: root });
    assert.equal(result.status, "written");
    assert.equal(readFileSync(join(root, "data/_views/mixed.md"), "utf8"), "2 rows\n- X\n  - Y\n");
  });
});

describe("bare init", () => {
  test("scaffolds data/ with no pack, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-bare-"));
    try {
      const first = init({ root: dir, pack: null });
      assert.deepEqual(first.written, ["data/README.md", "data/_views/.gitkeep"]);
      assert.equal(first.pack, null);
      assert.ok(existsSync(join(dir, "data/README.md")));

      const second = init({ root: dir, pack: null });
      assert.deepEqual(second.written, []);
      assert.equal(second.skipped.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
