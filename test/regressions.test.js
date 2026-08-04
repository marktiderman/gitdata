/**
 * Regression tests for audited defects. Each test names the failure it pins: these were all
 * reproduced against the engine before the fix, so a revert makes this file fail, not the demo.
 *
 * Self-contained like engine.test.js — fixture repos in temp dirs, no other checkout required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { parseFrontmatter, FrontmatterError } from "../src/frontmatter.js";
import { load, LoadError } from "../src/load.js";
import { project, query, ProjectError } from "../src/project.js";
import { renderTemplate, RenderError } from "../src/render.js";
import { diffLines, formatDiff, loadViewSpecs, rollup, ViewSpecError } from "../src/rollup.js";
import { orderBy } from "../src/shapes/sql.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

/** A throwaway fixture repo. Returns { root, write, rm }. */
function repo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(rel, text) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text, "utf8");
    },
    rm: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("frontmatter edge inputs", () => {
  test("canonical empty block `---\\n---\\n` parses as an empty mapping", () => {
    // GitHub, Obsidian, Jekyll, and gray-matter all accept the no-blank-line empty block; a stub
    // file awaiting metadata must not kill the rollup with "no frontmatter block".
    const { data, body } = parseFrontmatter("---\n---\nJust a body.\n");
    assert.deepEqual(data, {});
    assert.equal(body, "Just a body.\n");
    assert.deepEqual(parseFrontmatter("---\r\n---\r\nbody\r\n").data, {});
  });

  test("a UTF-8 BOM does not hide the frontmatter block", () => {
    const { data } = parseFrontmatter("﻿---\nid: X-1\n---\nbody\n");
    assert.deepEqual(data, { id: "X-1" });
  });

  test("still fails loud when there genuinely is no block", () => {
    assert.throws(() => parseFrontmatter("no fence here"), FrontmatterError);
  });
});

describe("load and symlinks", () => {
  test("a symlinked table directory loads instead of silently dropping every row", () => {
    const r = repo("gitdata-symlink-");
    try {
      r.write("elsewhere/L-001--linked.md", "---\nid: L-001\n---\nLinked.\n");
      mkdirSync(join(r.root, "data"), { recursive: true });
      symlinkSync(join(r.root, "elsewhere"), join(r.root, "data", "linked"), "dir");

      const tables = load(join(r.root, "data"));
      assert.deepEqual([...tables.keys()], ["linked"]);
      assert.equal(tables.get("linked").rows[0].id, "L-001");
    } finally {
      r.rm();
    }
  });

  test("a dangling symlink fails loud with the path, not a raw ENOENT", () => {
    const r = repo("gitdata-dangling-");
    try {
      r.write("data/things/T-001--real.md", "---\nid: T-001\n---\nReal.\n");
      symlinkSync(join(r.root, "gone.md"), join(r.root, "data", "things", "broken.md"), "file");

      assert.throws(() => load(join(r.root, "data")), (err) => {
        assert.ok(err instanceof LoadError);
        assert.match(err.message, /things\/broken\.md/);
        return true;
      });
    } finally {
      r.rm();
    }
  });
});

describe("projection", () => {
  test("case-colliding frontmatter keys name the table and both spellings", async () => {
    const r = repo("gitdata-case-");
    try {
      r.write("data/docs/a.md", "---\nStatus: draft\n---\nA.\n");
      r.write("data/docs/b.md", "---\nstatus: final\n---\nB.\n");

      await assert.rejects(project(load(join(r.root, "data"))), (err) => {
        assert.ok(err instanceof ProjectError);
        assert.match(err.message, /table "docs"/);
        assert.match(err.message, /"Status" and "status"/);
        return true;
      });
    } finally {
      r.rm();
    }
  });

  test("md_section matches the exact heading, never a heading it merely prefixes", async () => {
    const db = await project(new Map());
    try {
      const body = "## The job to be done\nWrong section.\n\n## The job\nRight section.\n";
      const v = query(db, `SELECT md_section('${body.replace(/'/g, "''")}', 'The job') AS v`)[0].v;
      assert.equal(v, "Right section.");
    } finally {
      db.close();
    }
  });
});

describe("render", () => {
  test("template lookup never walks the prototype chain", () => {
    // `{{r.toString}}` on a row without that column used to serialize Object.prototype.toString's
    // function source into the artifact — silently, so --check then blessed the wrong bytes.
    assert.throws(
      () => renderTemplate("{{r.toString}}", { r: [{ id: "X" }] }),
      (err) => err instanceof RenderError && /no column "toString"/.test(err.message),
    );
  });
});

describe("shapes", () => {
  test("the default tie-break is _file — the one column the engine guarantees", () => {
    // Defaulting to `id` baked a consumer column name into the engine and crashed any table
    // without one (law 1: the engine stays ignorant of any domain).
    assert.deepEqual(orderBy(undefined), ['"_file"']);
    assert.deepEqual(orderBy({ by: "priority" }), ['"priority"', '"_file"']);
    assert.deepEqual(orderBy({ by: "priority", tie_break: "id" }), ['"priority"', '"id"']);
  });

  test("a sections shape on a table with no id column works end to end", async () => {
    const r = repo("gitdata-noid-");
    try {
      r.write("data/notes/one.md", "---\ntopic: alpha\n---\nA.\n");
      r.write("data/notes/two.md", "---\ntopic: alpha\n---\nB.\n");
      r.write(
        "data/_views/notes.view.yml",
        [
          "id: notes",
          "out: data/_views/notes.md",
          "queries:",
          "  body:",
          "    shape: sections",
          "    sections:",
          "      - from: notes",
          "        columns: [topic]",
          "template: |",
          "  {{body}}",
        ].join("\n") + "\n",
      );

      const results = await rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root });
      assert.equal(results[0].status, "written");
      // Rows tie on `topic`; the _file tie-break keeps the artifact byte-stable.
      const artifact = readFileSync(join(r.root, "data/_views/notes.md"), "utf8");
      assert.ok(artifact.includes("| topic |"));
    } finally {
      r.rm();
    }
  });
});

describe("view specs", () => {
  const SPEC = (id, out) => `id: ${id}\nout: ${out}\nqueries:\n  q: SELECT 1 AS n\ntemplate: "{{q.n}}"\n`;

  test("duplicate view ids fail loud naming both files", () => {
    const r = repo("gitdata-dupid-");
    try {
      r.write("data/_views/a.view.yml", SPEC("board", "data/_views/a.md"));
      r.write("data/_views/b.view.yml", SPEC("board", "data/_views/b.md"));
      assert.throws(() => loadViewSpecs(join(r.root, "data")), (err) => {
        assert.ok(err instanceof ViewSpecError);
        assert.match(err.message, /duplicate view id "board"/);
        assert.match(err.message, /a\.view\.yml/);
        assert.match(err.message, /b\.view\.yml/);
        return true;
      });
    } finally {
      r.rm();
    }
  });

  test("two specs writing the same out fail loud instead of leaving --check failing forever", () => {
    const r = repo("gitdata-dupout-");
    try {
      r.write("data/_views/a.view.yml", SPEC("one", "data/_views/board.md"));
      r.write("data/_views/b.view.yml", SPEC("two", "./data/_views/board.md"));
      assert.throws(() => loadViewSpecs(join(r.root, "data")), /duplicate view out/);
    } finally {
      r.rm();
    }
  });
});

describe("rollup containment and drift", () => {
  test("out: escaping the repo root is refused", async () => {
    const r = repo("gitdata-escape-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", "id: v\nout: ../outside.md\nqueries:\n  q: SELECT 1 AS n\ntemplate: \"{{q.n}}\"\n");
      await assert.rejects(rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root }), ViewSpecError);
    } finally {
      r.rm();
    }
  });

  test("a symlinked directory cannot smuggle the write outside the repo root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gitdata-outside-"));
    const r = repo("gitdata-symlink-out-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      symlinkSync(outside, join(r.root, "data", "_evil"), "dir");
      // Lexically `data/_evil/x.md` is inside the repo; on disk it is not.
      r.write("data/_views/v.view.yml", "id: v\nout: data/_evil/x.md\nqueries:\n  q: SELECT 1 AS n\ntemplate: \"{{q.n}}\"\n");

      await assert.rejects(rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root }), /escapes the repo root/);
      assert.ok(!existsSync(join(outside, "x.md")), "wrote through the symlink");
    } finally {
      r.rm();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("check reports 'missing' for a never-rolled-up view and writes nothing", async () => {
    const r = repo("gitdata-missing-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", "id: v\nout: data/_views/v.md\nqueries:\n  q: SELECT 1 AS n\ntemplate: \"{{q.n}}\"\n");

      const results = await rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root, check: true });
      assert.equal(results[0].status, "missing");
      assert.ok(!existsSync(join(r.root, "data/_views/v.md")), "check mode wrote a file");
    } finally {
      r.rm();
    }
  });
});

describe("compile: escape hatch", () => {
  test("a compile module produces the artifact and sees the projected db", async () => {
    const r = repo("gitdata-compile-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", "id: v\nout: data/_views/v.md\ncompile: ./v.compile.js\n");
      r.write(
        "data/_views/v.compile.js",
        'export default (db, { query }) => `# Things: ${query(db, "SELECT COUNT(*) AS n FROM things")[0].n}\\n`;\n',
      );

      const results = await rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root });
      assert.equal(results[0].status, "written");
      assert.equal(readFileSync(join(r.root, "data/_views/v.md"), "utf8"), "# Things: 1\n");
    } finally {
      r.rm();
    }
  });

  test("a compile path escaping the repo root is refused", async () => {
    const r = repo("gitdata-compile-escape-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", "id: v\nout: data/_views/v.md\ncompile: ../../../evil.js\n");
      await assert.rejects(rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root }), /escapes the repo root/);
    } finally {
      r.rm();
    }
  });

  test("compile excludes queries/template, and must return a string", async () => {
    const r = repo("gitdata-compile-shape-");
    try {
      r.write(
        "data/_views/bad.view.yml",
        "id: bad\nout: data/_views/bad.md\ncompile: ./x.js\nqueries:\n  q: SELECT 1\ntemplate: x\n",
      );
      assert.throws(() => loadViewSpecs(join(r.root, "data")), /replaces "queries"\/"template"/);
      rmSync(join(r.root, "data/_views/bad.view.yml"));

      r.write("data/_views/v.view.yml", "id: v\nout: data/_views/v.md\ncompile: ./v.compile.js\n");
      r.write("data/_views/v.compile.js", "export default () => 42;\n");
      await assert.rejects(rollup({ dataRoot: join(r.root, "data"), repoRoot: r.root }), /must return a string/);
    } finally {
      r.rm();
    }
  });
});

describe("--check --diff / --json surface the drift instead of discarding it", () => {
  const VIEW = (out) =>
    `id: v\nout: ${out}\nqueries:\n  q: SELECT 1 AS n\ntemplate: "line {{q.n}}"\n`;

  test("diffLines/formatDiff render context, remove, and add lines from a plain two-sided compare", () => {
    // The unit underneath both flags: given the two strings `--check` already computes (compiled,
    // committed), the diff is not thrown away — it comes back as entries a caller can format or
    // serialize.
    const before = "keep\nremove me\nchange me\n";
    const after = "keep\nchange me too\nadd me\n";
    assert.deepEqual(diffLines(before, after), [
      { type: "context", line: "keep" },
      { type: "remove", line: "remove me" },
      { type: "remove", line: "change me" },
      { type: "add", line: "change me too" },
      { type: "add", line: "add me" },
      { type: "context", line: "" }, // the trailing "\n" on both sides is a shared empty line
    ]);
    assert.equal(
      formatDiff(diffLines(before, after)),
      [" keep", "-remove me", "-change me", "+change me too", "+add me", " "].join("\n"),
    );
  });

  test("`rollup --check --diff` prints the actual diff for a drifted view, not just its status", () => {
    const r = repo("gitdata-diff-drift-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", VIEW("data/_views/v.md"));
      r.write("data/_views/v.md", "line 9"); // hand-edited — the fresh render is "line 1"

      const withoutDiff = runCli(["rollup", "--check", "--root", r.root]);
      assert.equal(withoutDiff.status, 1);
      assert.match(withoutDiff.stdout, /drifted/);
      assert.ok(!withoutDiff.stdout.includes("line 9"), "plain --check still leaked diff content");

      const withDiff = runCli(["rollup", "--check", "--diff", "--root", r.root]);
      assert.equal(withDiff.status, 1, "exit code must stay the same with --diff added");
      assert.match(withDiff.stdout, /drifted/);
      assert.match(withDiff.stdout, /-line 9/);
      assert.match(withDiff.stdout, /\+line 1/);
    } finally {
      r.rm();
    }
  });

  test("`rollup --check --json` reports a missing view's shape, diff included only with --diff", () => {
    const r = repo("gitdata-json-missing-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", VIEW("data/_views/v.md"));

      const plain = runCli(["rollup", "--check", "--json", "--root", r.root]);
      assert.equal(plain.status, 1);
      const plainReport = JSON.parse(plain.stdout);
      assert.deepEqual(plainReport.summary, { total: 1, unchanged: 0, drifted: 0, missing: 1 });
      assert.equal(plainReport.views.length, 1);
      assert.equal(plainReport.views[0].id, "v");
      assert.equal(plainReport.views[0].status, "missing");
      assert.equal(plainReport.views[0].diff, undefined, "--json alone must not include diff content");

      const withDiff = runCli(["rollup", "--check", "--json", "--diff", "--root", r.root]);
      assert.equal(withDiff.status, 1);
      const report = JSON.parse(withDiff.stdout);
      // Nothing on disk yet — every rendered line reads as an addition.
      assert.deepEqual(report.views[0].diff, [{ type: "add", line: "line 1" }]);
    } finally {
      r.rm();
    }
  });

  test("`rollup --check --json` on a clean repo reports every view unchanged with an empty diff list", () => {
    const r = repo("gitdata-json-clean-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", VIEW("data/_views/v.md"));

      assert.equal(runCli(["rollup", "--root", r.root]).status, 0);

      const result = runCli(["rollup", "--check", "--json", "--diff", "--root", r.root]);
      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.summary, { total: 1, unchanged: 1, drifted: 0, missing: 0 });
      assert.equal(report.views.length, 1);
      assert.equal(report.views[0].status, "unchanged");
      assert.equal(report.views[0].diff, undefined, "a clean view carries no diff — nothing changed");
    } finally {
      r.rm();
    }
  });

  test("--diff and --json are inert without --check — a writing rollup is unaffected", () => {
    const r = repo("gitdata-diff-noop-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", VIEW("data/_views/v.md"));

      const result = runCli(["rollup", "--diff", "--json", "--root", r.root]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /rolled up/);
      assert.ok(!result.stdout.trim().startsWith("{"), "writing mode must not emit the JSON report");
      assert.equal(readFileSync(join(r.root, "data/_views/v.md"), "utf8"), "line 1");
    } finally {
      r.rm();
    }
  });

  test("existing --check exit-code contract is unchanged: 0 clean, 1 drifted, 1 missing", () => {
    // Pinning the contract the new flags must not disturb — same fixture shape as the "check
    // reports 'missing'" test above, walked through all three states.
    const r = repo("gitdata-check-contract-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/_views/v.view.yml", VIEW("data/_views/v.md"));

      assert.equal(runCli(["rollup", "--check", "--root", r.root]).status, 1); // missing

      assert.equal(runCli(["rollup", "--root", r.root]).status, 0);
      assert.equal(runCli(["rollup", "--check", "--root", r.root]).status, 0); // clean

      writeFileSync(join(r.root, "data/_views/v.md"), "line 1\nvandalism\n");
      assert.equal(runCli(["rollup", "--check", "--root", r.root]).status, 1); // drifted
    } finally {
      r.rm();
    }
  });
});
