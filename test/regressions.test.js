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
import { after, before, describe, test } from "node:test";

import { codeownersLines, emitCodeowners, EmitError, renderCodeowners } from "../src/emit-codeowners.js";
import { parseFrontmatter, FrontmatterError } from "../src/frontmatter.js";
import { init } from "../src/init.js";
import { assertReadOnly, describeTables, runQuery, QueryError } from "../src/introspect.js";
import { load, LoadError } from "../src/load.js";
import { project, query, ProjectError } from "../src/project.js";
import { renderTemplate, RenderError } from "../src/render.js";
import { diffLines, formatDiff, loadViewSpecs, rollup, ViewSpecError } from "../src/rollup.js";
import { orderBy } from "../src/shapes/sql.js";
import { loadSchemas, validate, SchemaSpecError } from "../src/validate.js";

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

describe("emit codeowners", () => {
  test("a table with no _owners.yml gets no CODEOWNERS line", () => {
    const r = repo("gitdata-codeowners-none-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      assert.deepEqual(codeownersLines({ dataRoot: join(r.root, "data"), repoRoot: r.root }), []);
      assert.equal(renderCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root }), null);
    } finally {
      r.rm();
    }
  });

  test("lines are sorted by table name, never directory order", () => {
    const r = repo("gitdata-codeowners-sort-");
    try {
      // Written zebras-then-apples on purpose: alphabetical output must not be an accident of
      // write order, the same determinism guarantee `load()` gives table rows.
      r.write("data/zebras/Z-1.md", "---\nid: Z-1\n---\nZ.\n");
      r.write("data/zebras/_owners.yml", 'owners: ["@zoo"]\n');
      r.write("data/apples/A-1.md", "---\nid: A-1\n---\nA.\n");
      r.write("data/apples/_owners.yml", 'owners: ["@orchard"]\n');

      const lines = codeownersLines({ dataRoot: join(r.root, "data"), repoRoot: r.root });
      assert.deepEqual(lines, ["/data/apples/** @orchard", "/data/zebras/** @zoo"]);
    } finally {
      r.rm();
    }
  });

  test("a repo-wide data/_owners.yml default is emitted first, before per-table lines", () => {
    const r = repo("gitdata-codeowners-default-");
    try {
      r.write("data/_owners.yml", 'owners: ["@default-team"]\n');
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/things/_owners.yml", 'owners: ["@things-team"]\n');

      const lines = codeownersLines({ dataRoot: join(r.root, "data"), repoRoot: r.root });
      // GitHub's own last-match-wins rule is what lets the more specific line that follows
      // override the default — gitdata only has to get the order right, never the precedence.
      assert.deepEqual(lines, ["/data/** @default-team", "/data/things/** @things-team"]);
    } finally {
      r.rm();
    }
  });

  test("owners must be a non-empty list of strings — a bad shape fails loud naming the file", () => {
    const r = repo("gitdata-codeowners-bad-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/things/_owners.yml", "owners: []\n");
      assert.throws(() => codeownersLines({ dataRoot: join(r.root, "data"), repoRoot: r.root }), (err) => {
        assert.ok(err instanceof EmitError);
        assert.match(err.message, /things\/_owners\.yml/);
        assert.match(err.message, /non-empty list/);
        return true;
      });

      r.write("data/things/_owners.yml", "owners:\n  - \"\"\n");
      assert.throws(() => codeownersLines({ dataRoot: join(r.root, "data"), repoRoot: r.root }), /non-empty string/);
    } finally {
      r.rm();
    }
  });

  test("check reports 'missing' for a never-emitted CODEOWNERS and writes nothing", () => {
    const r = repo("gitdata-codeowners-missing-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/things/_owners.yml", 'owners: ["@team"]\n');
      const outPath = join(r.root, ".github/CODEOWNERS");

      const result = emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath, check: true });
      assert.equal(result.status, "missing");
      assert.ok(!existsSync(outPath), "check mode wrote a file");
    } finally {
      r.rm();
    }
  });

  test("check reports 'drifted' against a hand-edited CODEOWNERS, and a clean re-run is byte-identical", () => {
    const r = repo("gitdata-codeowners-drift-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      r.write("data/things/_owners.yml", 'owners: ["@team"]\n');
      const outPath = join(r.root, ".github/CODEOWNERS");

      const first = emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath });
      assert.equal(first.status, "written");
      const bytes = readFileSync(outPath, "utf8");

      // Clean → unchanged, determinism observed rather than assumed.
      assert.equal(
        emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath, check: true }).status,
        "unchanged",
      );

      writeFileSync(outPath, bytes + "\n# hand-added\n");
      const drift = emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath, check: true });
      assert.equal(drift.status, "drifted");
      assert.equal(readFileSync(outPath, "utf8"), bytes + "\n# hand-added\n", "check mode wrote a file");
    } finally {
      r.rm();
    }
  });

  test("no _owners.yml anywhere leaves an existing hand-authored CODEOWNERS untouched", () => {
    const r = repo("gitdata-codeowners-empty-");
    try {
      r.write("data/things/T-001.md", "---\nid: T-001\n---\nBody.\n");
      const outPath = join(r.root, ".github/CODEOWNERS");
      r.write(".github/CODEOWNERS", "* @hand-authored\n");

      const result = emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath });
      assert.equal(result.status, "empty");
      assert.equal(readFileSync(outPath, "utf8"), "* @hand-authored\n");
    } finally {
      r.rm();
    }
  });

  test("a repo with no data/ directory at all reports 'empty' instead of crashing", () => {
    const r = repo("gitdata-codeowners-nodata-");
    try {
      const outPath = join(r.root, ".github/CODEOWNERS");
      const result = emitCodeowners({ dataRoot: join(r.root, "data"), repoRoot: r.root, outPath });
      assert.equal(result.status, "empty");
    } finally {
      r.rm();
    }
  });

  test("real specimen: feature-management's features table produces the exact byte output", () => {
    // Law 6: validated against a real committed artifact — the actual shipped pack, scaffolded
    // through the real `init()`, not a hand-rolled fixture that merely resembles it.
    const r = repo("gitdata-codeowners-specimen-");
    try {
      const { written } = init({ root: r.root, pack: "feature-management" });
      assert.ok(written.includes("data/features/_template.md"));

      r.write("data/features/_owners.yml", 'owners:\n  - "@alice"\n  - "@bob"\n');

      const dataRoot = join(r.root, "data");
      const expected =
        "# CODEOWNERS — generated by `gitdata emit codeowners` from data/<table>/_owners.yml.\n" +
        "# Do not hand-edit: `gitdata emit codeowners --check` fails if you do.\n" +
        "# Declare ownership as data — add or edit a table's _owners.yml, then re-run.\n" +
        "\n" +
        "/data/features/** @alice @bob\n";

      assert.equal(renderCodeowners({ dataRoot, repoRoot: r.root }), expected);

      const outPath = join(r.root, ".github/CODEOWNERS");
      const result = emitCodeowners({ dataRoot, repoRoot: r.root, outPath });
      assert.equal(result.status, "written");
      assert.equal(readFileSync(outPath, "utf8"), expected);
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

let root;

function write(rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "gitdata-validate-"));

  write(
    "data/_schema/widgets.schema.yml",
    [
      "kind: table-schema",
      "required: [id, title, status]",
      "unique: [id]",
      "enum:",
      "  status: [idea, shipped]",
      "pattern:",
      "  id: '^W-\\d{3}$'",
      "ref:",
      "  parent: widgets.id",
      "",
    ].join("\n"),
  );

  write("data/widgets/w1.md", "---\nid: W-001\ntitle: One\nstatus: idea\nparent: null\n---\n");
  // Missing `title`, invalid status, malformed id, and a parent naming no row — one row that
  // trips every rule at once so a report is proven to carry all of them, not just the first hit.
  write("data/widgets/w2.md", "---\nid: BAD\nstatus: nope\nparent: nowhere\n---\n");
  // Shares W-001's id with w1 — the duplicate `unique` must catch.
  write("data/widgets/w3.md", "---\nid: W-001\ntitle: Also one\nstatus: shipped\nparent: W-001\n---\n");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("loadSchemas", () => {
  test("a repo with no data/_schema/ has no schemas — validate is opt-in, not mandatory", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-noschema-"));
    try {
      assert.deepEqual(loadSchemas(join(dir, "data")), []);
      assert.deepEqual(validate({ dataRoot: join(dir, "data") }), { tables: [], issues: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a `table:` field that disagrees with its filename fails loud, not silently on the wrong table", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-tablemismatch-"));
    try {
      mkdirSync(join(dir, "data/_schema"), { recursive: true });
      writeFileSync(join(dir, "data/_schema/widgets.schema.yml"), "table: gadgets\nrequired: [id]\n");
      assert.throws(() => loadSchemas(join(dir, "data")), SchemaSpecError, /disagrees with its filename/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognized rule key fails loud rather than being silently ignored", () => {
    // A typo'd rule (`requird:`) that the engine ignores would validate nothing and report
    // success — worse than not having a schema at all, because it looks checked.
    const dir = mkdtempSync(join(tmpdir(), "gitdata-badrule-"));
    try {
      mkdirSync(join(dir, "data/_schema"), { recursive: true });
      writeFileSync(join(dir, "data/_schema/widgets.schema.yml"), "requird: [id]\n");
      assert.throws(() => loadSchemas(join(dir, "data")), SchemaSpecError, /unknown rule/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a ref target that is not `table.column` fails loud at validate time", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-badref-"));
    try {
      mkdirSync(join(dir, "data/_schema"), { recursive: true });
      mkdirSync(join(dir, "data/widgets"), { recursive: true });
      writeFileSync(join(dir, "data/_schema/widgets.schema.yml"), "ref:\n  parent: widgets\n");
      writeFileSync(join(dir, "data/widgets/w.md"), "---\nid: W-001\nparent: W-001\n---\n");
      assert.throws(() => validate({ dataRoot: join(dir, "data") }), SchemaSpecError, /table\.column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalid regex in `pattern:` fails loud rather than throwing an opaque RegExp error", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-badpattern-"));
    try {
      mkdirSync(join(dir, "data/_schema"), { recursive: true });
      mkdirSync(join(dir, "data/widgets"), { recursive: true });
      writeFileSync(join(dir, "data/_schema/widgets.schema.yml"), "pattern:\n  id: '('\n");
      writeFileSync(join(dir, "data/widgets/w.md"), "---\nid: W-001\n---\n");
      assert.throws(() => validate({ dataRoot: join(dir, "data") }), SchemaSpecError, /widgets\.schema\.yml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validate", () => {
  test("required: a missing column is reported by table, file, rule and column — not just a count", () => {
    const { issues } = validate({ dataRoot: join(root, "data") });
    const missing = issues.find((i) => i.rule === "required" && i.file === "w2.md");
    assert.ok(missing, "expected a required-column issue for w2.md");
    assert.equal(missing.table, "widgets");
    assert.equal(missing.column, "title");
  });

  test("unique: both rows sharing a value are flagged, not just the second one seen", () => {
    // Flagging only the later row hides which row is "correct" — both must be named so an author
    // can tell the two apart without re-deriving the collision by hand.
    const { issues } = validate({ dataRoot: join(root, "data") });
    const dupes = issues.filter((i) => i.rule === "unique" && i.column === "id");
    assert.deepEqual(
      dupes.map((i) => i.file).sort(),
      ["w1.md", "w3.md"],
    );
  });

  test("enum: a value outside the declared set is flagged, naming what it must be", () => {
    const { issues } = validate({ dataRoot: join(root, "data") });
    const bad = issues.find((i) => i.rule === "enum" && i.file === "w2.md");
    assert.ok(bad);
    assert.match(bad.message, /idea, shipped/);
  });

  test("pattern: a value failing the regex is flagged", () => {
    const { issues } = validate({ dataRoot: join(root, "data") });
    assert.ok(issues.some((i) => i.rule === "pattern" && i.file === "w2.md" && i.column === "id"));
  });

  test("ref: a value naming no row in the target table/column is flagged, a self-reference is not", () => {
    // w3's parent (`W-001`) resolves to w1 — a self-referencing table must not treat "some row
    // in my own table" as automatically dangling just because it's the same table being checked.
    const { issues } = validate({ dataRoot: join(root, "data") });
    assert.ok(issues.some((i) => i.rule === "ref" && i.file === "w2.md" && i.column === "parent"));
    assert.ok(!issues.some((i) => i.rule === "ref" && i.file === "w3.md"));
  });

  test("null is a legitimate absence, not a dangling reference — w1's null parent draws no ref issue", () => {
    // w1 also shares its id with w3 (the `unique` fixture above), so it legitimately carries a
    // `unique` issue — this checks only that `ref` treats its null `parent` as absence, not as a
    // value that fails to resolve.
    const { issues } = validate({ dataRoot: join(root, "data") });
    assert.ok(!issues.some((i) => i.file === "w1.md" && i.rule === "ref"));
  });

  test("a table with no schema file is not checked, even when a sibling table has one", () => {
    write("data/untouched/u1.md", "---\nnonsense: yes\n---\n");
    const { tables, issues } = validate({ dataRoot: join(root, "data") });
    assert.deepEqual(tables, ["widgets"]);
    assert.ok(!issues.some((i) => i.table === "untouched"));
  });

  test("issue order is deterministic — sorted by table, file, rule, column, not Map/object iteration order", () => {
    const a = validate({ dataRoot: join(root, "data") }).issues;
    const b = validate({ dataRoot: join(root, "data") }).issues;
    assert.deepEqual(a, b);
    const sorted = [...a].sort(
      (x, y) =>
        x.table.localeCompare(y.table) ||
        x.file.localeCompare(y.file) ||
        x.rule.localeCompare(y.rule) ||
        x.column.localeCompare(y.column),
    );
    assert.deepEqual(a, sorted);
  });
});

describe("gitdata validate (CLI)", () => {
  test("exits non-zero and prints table/file/rule/reason when rows fail their schema", () => {
    const result = runCli(["validate", "--root", root]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /widgets/);
    assert.match(result.stdout, /w2\.md/);
    assert.match(result.stdout, /required|enum|pattern|ref/);
  });

  test("exits zero and reports nothing to check when no data/_schema/ exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-cli-noschema-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      const result = runCli(["validate", "--root", dir]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /no schemas found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits zero when every row satisfies its schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdata-cli-clean-"));
    try {
      mkdirSync(join(dir, "data/_schema"), { recursive: true });
      mkdirSync(join(dir, "data/widgets"), { recursive: true });
      writeFileSync(join(dir, "data/_schema/widgets.schema.yml"), "required: [id]\n");
      writeFileSync(join(dir, "data/widgets/w.md"), "---\nid: W-001\n---\n");
      const result = runCli(["validate", "--root", dir]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /0 issues/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--help documents validate alongside rollup and init", () => {
    const result = runCli([]);
    assert.match(result.stdout, /gitdata validate/);
  });
});

describe("real specimen: the feature-management pack's shipped schema", () => {
  // Law 6: proved against the actual committed pack files — copied onto disk by the real `init`
  // pipeline, not retyped as inline YAML — rather than a schema invented only for this test.
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "gitdata-pack-schema-"));
    init({ root: dir, pack: "feature-management" });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the pack ships data/_schema/features.schema.yml", () => {
    const [schema] = loadSchemas(join(dir, "data"));
    assert.equal(schema.table, "features");
    assert.deepEqual(schema.unique, ["id"]);
  });

  test("the pack's own _template.md, copied to a real row, satisfies the pack's own schema", () => {
    // The template's placeholder values (F-000, status: idea, priority: P2) are themselves a
    // worked example — if they didn't satisfy the shipped schema, the pack would be handing new
    // users a first row that fails their own first `gitdata validate`.
    const templateText = readFileSync(join(dir, "data/features/_template.md"), "utf8");
    writeFileSync(join(dir, "data/features/F-000--example.md"), templateText, "utf8");

    const { issues } = validate({ dataRoot: join(dir, "data") });
    assert.deepEqual(issues, []);
  });

  test("mutating the copied template to violate the shipped schema is caught", () => {
    const templateText = readFileSync(join(dir, "data/features/_template.md"), "utf8");
    const broken = templateText.replace("status: idea", "status: not-a-real-status");
    writeFileSync(join(dir, "data/features/F-001--broken.md"), broken, "utf8");

    const { issues } = validate({ dataRoot: join(dir, "data") });
    const found = issues.find((i) => i.file === "F-001--broken.md" && i.rule === "enum");
    assert.ok(found, "expected the shipped enum rule to reject an invalid status");
    assert.equal(found.column, "status");
  });
});

describe("introspection (tables/query)", () => {
  test("describeTables lists tables and columns sorted by name, independent of frontmatter key order", async () => {
    const r = repo("gitdata-tables-");
    try {
      // Deliberately opposite key order between the two rows — column sort must not depend on it.
      r.write("data/things/a.md", "---\ntier: 2\nid: T-002\n---\nA.\n");
      r.write("data/things/b.md", "---\nid: T-001\ntier: 1\n---\nB.\n");
      mkdirSync(join(r.root, "data/empty"), { recursive: true });

      const result = await describeTables(join(r.root, "data"));

      assert.deepEqual(result.map((t) => t.table), ["empty", "things"]);

      const empty = result.find((t) => t.table === "empty");
      assert.equal(empty.rows, 0);
      // A table with no rows still gets `_file` (project.js guarantees it), typed `null` since no
      // value was ever stored in it.
      assert.deepEqual(empty.columns, [{ name: "_file", type: "null" }]);

      const things = result.find((t) => t.table === "things");
      assert.equal(things.rows, 2);
      // Every key load.js puts on a row is included — `_body` (the markdown body) as well as `_file`.
      assert.deepEqual(
        things.columns.map((c) => c.name),
        ["_body", "_file", "id", "tier"],
      );
      assert.deepEqual(things.columns.find((c) => c.name === "id").type, "text");
      assert.deepEqual(things.columns.find((c) => c.name === "tier").type, "integer");
    } finally {
      r.rm();
    }
  });

  test("describeTables reports a mixed-type column as the sorted union of its storage classes", async () => {
    const r = repo("gitdata-tables-mixed-");
    try {
      r.write("data/things/a.md", "---\nid: T-001\ncount: 1\n---\nA.\n");
      r.write("data/things/b.md", '---\nid: T-002\ncount: "two"\n---\nB.\n');

      const [things] = await describeTables(join(r.root, "data"));
      assert.equal(things.columns.find((c) => c.name === "count").type, "integer|text");
    } finally {
      r.rm();
    }
  });

  test("assertReadOnly accepts SELECT/WITH/EXPLAIN and rejects writes, multi-statements, and non-reads", () => {
    assert.equal(assertReadOnly("SELECT * FROM things"), "SELECT * FROM things");
    assert.equal(assertReadOnly("  select 1  "), "select 1");
    assert.equal(assertReadOnly("WITH x AS (SELECT 1) SELECT * FROM x"), "WITH x AS (SELECT 1) SELECT * FROM x");
    assert.equal(assertReadOnly("EXPLAIN SELECT 1"), "EXPLAIN SELECT 1");
    // A trailing semicolon on an otherwise-single statement is not a second statement.
    assert.equal(assertReadOnly("SELECT 1;"), "SELECT 1");

    for (const sql of [
      "INSERT INTO things (id) VALUES ('X')",
      "UPDATE things SET id = 'X'",
      "DELETE FROM things",
      "DROP TABLE things",
      "ATTACH DATABASE 'x' AS x",
      "CREATE TABLE evil (x)",
      "PRAGMA table_info(things)",
    ]) {
      assert.throws(() => assertReadOnly(sql), QueryError, sql);
    }

    assert.throws(() => assertReadOnly("SELECT 1; DROP TABLE things"), QueryError);
    assert.throws(() => assertReadOnly(""), QueryError);
  });

  test("runQuery runs a real read against the projection, and refuses a mutating statement before touching it", async () => {
    const r = repo("gitdata-query-");
    try {
      r.write("data/things/a.md", "---\nid: T-001\n---\nA.\n");
      r.write("data/things/b.md", "---\nid: T-002\n---\nB.\n");

      const rows = await runQuery(join(r.root, "data"), "SELECT id FROM things ORDER BY id");
      assert.deepEqual(rows, [{ id: "T-001" }, { id: "T-002" }]);

      await assert.rejects(runQuery(join(r.root, "data"), "DELETE FROM things"), QueryError);
      // The guard fired; nothing was deleted from the (fresh, per-call) projection either way, but
      // a second read confirms the statement was never allowed to run at all.
      const stillTwo = await runQuery(join(r.root, "data"), "SELECT COUNT(*) AS n FROM things");
      assert.equal(stillTwo[0].n, 2);
    } finally {
      r.rm();
    }
  });
});
