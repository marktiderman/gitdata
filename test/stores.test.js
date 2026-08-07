/**
 * `stores` — the master table of contents for a repo holding more than one trellis.
 *
 * The point of the command is that a repo with three stores has no way to see them together, and
 * what cannot be enumerated cannot be audited. So the tests that matter are: it finds all of them,
 * it finds them in a repo that never adopted a manifest, and it does not mistake a table's own
 * subdirectory for another store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { describeStores, findStores } from "../src/stores.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "gitdata-stores-"));
  return {
    root,
    write(rel, body) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    dir(rel) {
      mkdirSync(join(root, rel), { recursive: true });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("finding stores", () => {
  test("finds every trellis in a multi-store repo, root included", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("sdk/data/envelopes/e.md", "---\nid: E-1\n---\nE.\n");
      r.write("registry/data/games/g.md", "---\nid: G-1\n---\nG.\n");
      const found = describeStores(r.root).map((s) => s.data).sort();
      assert.deepEqual(found, ["data", join("registry", "data"), join("sdk", "data")].sort());
    } finally {
      r.cleanup();
    }
  });

  test("a store needs no manifest to be listed — discovery is not opt-in", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const [store] = describeStores(r.root);
      assert.equal(store.manifest, false);
      assert.equal(store.engine, null);
      assert.equal(store.tables[0].name, "things");
      assert.equal(store.tables[0].rows, 1);
    } finally {
      r.cleanup();
    }
  });

  test("a manifest supplies the engine range and each table's class", () => {
    const r = repo();
    try {
      r.write("data/games/g.md", "---\nid: G-1\nsource_sha: abc\n---\nG.\n");
      r.write("data/envelopes/e.md", "---\nid: E-1\n---\nE.\n");
      r.write(
        "data/_gitdata.yml",
        'engine: ">=0.2.0"\ntables:\n  games: { class: measured, written_by: "an extract script", provenance: [source_sha] }\n  envelopes: { class: authored }\n',
      );
      const [store] = describeStores(r.root);
      assert.equal(store.manifest, true);
      assert.equal(store.engine, ">=0.2.0");
      assert.deepEqual(
        store.tables.map((t) => [t.name, t.class, t.rows]),
        [
          ["envelopes", "authored", 1],
          ["games", "measured", 1],
        ],
      );
      assert.equal(store.tables.find((t) => t.name === "games").written_by, "an extract script");
    } finally {
      r.cleanup();
    }
  });

  test("a table nobody classified reads UNKNOWN, never blank", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/_gitdata.yml", 'engine: ">=0.1.0"\n');
      assert.equal(describeStores(r.root)[0].tables[0].class, null);
      const out = run(["stores", "--root", r.root]);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /things\s+UNKNOWN\s+1 row/);
    } finally {
      r.cleanup();
    }
  });

  test("a declaration pointing at no directory is surfaced, not dropped", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/_gitdata.yml", "tables:\n  ghosts: { class: measured }\n");
      const table = describeStores(r.root)[0].tables.find((t) => t.name === "ghosts");
      assert.equal(table.rows, null);
      assert.equal(table.class, "measured");
    } finally {
      r.cleanup();
    }
  });

  test("a data/ with only reserved directories is still a store; an empty one is not", () => {
    const marked = repo();
    try {
      marked.dir("data/_views");
      assert.equal(findStores(marked.root).length, 1);
    } finally {
      marked.cleanup();
    }

    const empty = repo();
    try {
      empty.dir("data");
      assert.deepEqual(findStores(empty.root), []);
    } finally {
      empty.cleanup();
    }
  });

  test("never descends into a store's own data/, so a shard is not mistaken for a store", () => {
    const r = repo();
    try {
      // A nested shard, and a directory literally called `data` inside a table.
      r.write("data/things/2026/01/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/things/data/things/b.md", "---\nid: T-2\n---\nB.\n");
      const found = findStores(r.root);
      assert.equal(found.length, 1);
      assert.equal(describeStores(r.root)[0].tables.length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("skips node_modules and dot-directories", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("node_modules/dep/data/things/b.md", "---\nid: T-2\n---\nB.\n");
      r.write(".cache/data/things/c.md", "---\nid: T-3\n---\nC.\n");
      assert.deepEqual(findStores(r.root).map((s) => s.data), [join(r.root, "data")]);
    } finally {
      r.cleanup();
    }
  });

  test("output is deterministic, and --json parses", () => {
    const r = repo();
    try {
      r.write("data/b/x.md", "---\nid: 1\n---\nX.\n");
      r.write("data/a/y.md", "---\nid: 2\n---\nY.\n");
      r.write("sdk/data/z/z.md", "---\nid: 3\n---\nZ.\n");
      const a = run(["stores", "--json", "--root", r.root]);
      const b = run(["stores", "--json", "--root", r.root]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(a.stdout, b.stdout);
      const parsed = JSON.parse(a.stdout);
      assert.equal(parsed.length, 2);
      assert.deepEqual(parsed[0].tables.map((t) => t.name), ["a", "b"]);
    } finally {
      r.cleanup();
    }
  });

  test("a repo with no trellis says so and exits 0", () => {
    const r = repo();
    try {
      const out = run(["stores", "--root", r.root]);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /no stores found/);
    } finally {
      r.cleanup();
    }
  });

  test("stores writes nothing", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const before = run(["stores", "--json", "--root", r.root]).stdout;
      run(["stores", "--root", r.root]);
      assert.equal(run(["stores", "--json", "--root", r.root]).stdout, before);
    } finally {
      r.cleanup();
    }
  });
});
