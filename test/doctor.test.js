/**
 * `doctor` — every check firing AND not firing, the exit-code matrix, and the policy file.
 *
 * Two things are load-bearing here and are tested as contracts, not as details:
 *
 *   1. **No flags exits 0, whatever it finds.** gitdata guides; GitHub enforces. A compliance verb
 *      that broke a dev shell the first time it disagreed with you would simply stop being run.
 *   2. **A check that could not run says so.** Silence is never a pass. GD005 and GD111 both have
 *      "cannot know yet" states, and both are asserted to land in `skipped`, never in a clean bill.
 *
 * A check observed only NOT firing is a check nobody has tested — every entry in the catalog is
 * exercised in both directions, including the three whose input a test cannot otherwise vary
 * (the registry, the bundled packs, the running node), which is what the seams on `doctor()` are
 * for.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { CHECKS, doctor, exitCode, readPolicy, runCommands } from "../src/doctor.js";
import { load } from "../src/load.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const REPO = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const NAME = PKG.name;

const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });

/** A throwaway repo root. Every test gets its own; nothing here ever writes into the project. */
function repo(prefix = "gitdata-doctor-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(rel, body) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return path;
    },
    policy(body) {
      return this.write("data/_gitdata.yml", body);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Never contact the registry from a test. GD004 gets an explicit answer or `--offline`. */
const noLatest = async () => null;
const latest = (v) => async () => v;

const of = (report, id) => report.findings.filter((f) => f.id === id);
const skippedIds = (report) => report.skipped.map((s) => s.id);

/** The default invocation for a test: offline, real packs, real node, unless a test says otherwise. */
const check = (root, opts = {}) => doctor({ root, offline: true, fetchLatest: noLatest, ...opts });

describe("doctor: the catalog", () => {
  test("every check has a unique id, a name, and a level in the vocabulary", () => {
    const ids = CHECKS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of CHECKS) {
      assert.match(c.id, /^GD\d{3}$/);
      assert.match(c.name, /^[a-z][a-z-]+$/);
      assert.ok(["error", "warn", "off"].includes(c.level), `${c.id} level ${c.level}`);
    }
  });

  test("a clean empty repo reports nothing and exits 0", async () => {
    const r = repo();
    try {
      const report = await check(r.root);
      assert.deepEqual(report.findings, []);
      assert.deepEqual(report.summary, { error: 0, warn: 0, off: 0 });
      // Silence is not a pass: everything that could not run said so.
      assert.ok(report.skipped.length > 0);
    } finally {
      r.cleanup();
    }
  });
});

describe("the policy file", () => {
  test("`data/_gitdata.yml` is invisible to the loader — the reservation doctor relies on", () => {
    // Asserted against load() itself, not assumed from reading src/load.js: the `_` prefix is the
    // whole reason this file can live inside data/ without becoming a row or a table.
    const r = repo();
    try {
      r.policy("engine: \">=0.1.0\"\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const tables = load(join(r.root, "data"));
      assert.deepEqual([...tables.keys()], ["things"]);
      assert.equal(tables.get("things").rows.length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("an absent policy file is a legitimate no-op", () => {
    const r = repo();
    try {
      const policy = readPolicy(join(r.root, "data"));
      assert.equal(policy.present, false);
      assert.deepEqual(policy.defects, []);
      assert.deepEqual(policy.checks, {});
    } finally {
      r.cleanup();
    }
  });

  test("lowering WITH a reason takes effect", () => {
    const r = repo();
    try {
      r.policy('checks:\n  GD109: { level: off, reason: "artifacts are built elsewhere" }\n');
      const policy = readPolicy(join(r.root, "data"));
      assert.deepEqual(policy.defects, []);
      assert.deepEqual(policy.checks.GD109, { level: "off", reason: "artifacts are built elsewhere" });
    } finally {
      r.cleanup();
    }
  });

  test("raising a level needs no reason", () => {
    const r = repo();
    try {
      r.policy("checks:\n  GD004: { level: error }\n");
      const policy = readPolicy(join(r.root, "data"));
      assert.deepEqual(policy.defects, []);
      assert.equal(policy.checks.GD004.level, "error");
    } finally {
      r.cleanup();
    }
  });

  test("YAML parses `off` as the string, not as false", () => {
    // The whole severity vocabulary would silently break under YAML 1.1 boolean coercion.
    const r = repo();
    try {
      r.policy('checks:\n  GD111: { level: off, reason: "no provenance yet" }\n');
      assert.equal(readPolicy(join(r.root, "data")).checks.GD111.level, "off");
    } finally {
      r.cleanup();
    }
  });

  test("a malformed policy is a defect and never crashes the reader", () => {
    const cases = [
      ["checks:\n  GD999: { level: off, reason: x }\n", /unknown check id "GD999"/],
      ["checks:\n  GD109: { level: silent, reason: x }\n", /is not one of error, warn, off/],
      ["checks:\n  GD109: off\n", /must be a mapping/],
      ["checks:\n  GD109: { level: off, reason: x, note: y }\n", /unknown key "note"/],
      ["nonsense: true\n", /unknown key "nonsense"/],
      ["- a\n- b\n", /must be a mapping/],
      ["engine: 3\n", /"engine" must be a version range string/],
      ["packs:\n  feature-management: latest\n", /must be an exact installed version/],
      ["tables:\n  x: { class: invented }\n", /is not one of authored, measured, derived/],
      ["tables:\n  x: { class: measured, provenance: 7 }\n", /must be a list of column names/],
      ["checks: [1, 2]\n", /"checks" must be a mapping/],
      ["a: [\n", /not valid YAML/],
    ];
    for (const [body, pattern] of cases) {
      const r = repo();
      try {
        r.policy(body);
        const policy = readPolicy(join(r.root, "data"));
        assert.equal(policy.defects.length >= 1, true, `no defect for ${JSON.stringify(body)}`);
        assert.match(policy.defects.join("\n"), pattern);
      } finally {
        r.cleanup();
      }
    }
  });
});

describe("GD000 · suppression-without-reason", () => {
  test("fires when a check is lowered with no reason, AND the suppression does not take effect", async () => {
    const r = repo();
    try {
      // A real GD109 error to suppress: a view whose artifact was never rolled up.
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/x.view.yml",
        "id: x\nout: data/_views/x.md\nqueries:\n  rows: \"SELECT id AS line FROM things\"\ntemplate: |\n  {{rows}}\n",
      );
      r.policy("checks:\n  GD109: { level: off }\n");

      const report = await check(r.root);
      assert.equal(of(report, "GD000").length, 1);
      assert.match(of(report, "GD000")[0].message, /lowers error to off with no "reason"/);
      // The unjustified suppression was ignored — GD109 kept its default severity.
      assert.equal(of(report, "GD109").length, 1);
      assert.equal(of(report, "GD109")[0].level, "error");
      assert.deepEqual(report.silenced, []);
    } finally {
      r.cleanup();
    }
  });

  test("does not fire when the reason is present, and the check is then silenced with it", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/x.view.yml",
        "id: x\nout: data/_views/x.md\nqueries:\n  rows: \"SELECT id AS line FROM things\"\ntemplate: |\n  {{rows}}\n",
      );
      r.policy('checks:\n  GD109: { level: off, reason: "the artifact is built by another job" }\n');

      const report = await check(r.root);
      assert.deepEqual(of(report, "GD000"), []);
      assert.equal(of(report, "GD109")[0].level, "off");
      assert.equal(report.summary.error, 0);
      assert.equal(report.summary.off, 1);
      // The divergence stays visible and attributed.
      assert.deepEqual(report.silenced, [
        { id: "GD109", check: "rollup-drift", from: "error", level: "off", reason: "the artifact is built by another job", findings: 1 },
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("an empty-string reason is no reason", async () => {
    const r = repo();
    try {
      r.policy('checks:\n  GD109: { level: warn, reason: "   " }\n');
      const report = await check(r.root);
      assert.equal(of(report, "GD000").length, 1);
    } finally {
      r.cleanup();
    }
  });
});

describe("GD001 · unpinned-runner", () => {
  const script = (cmd) => JSON.stringify({ name: "consumer", scripts: { data: cmd } }, null, 2);

  test("fires on an unpinned runner in a package.json script", async () => {
    for (const cmd of [`npx ${NAME} rollup --check`, `bunx ${NAME} validate`, `pnpm dlx ${NAME} rollup`, `npx -y ${NAME} rollup`]) {
      const r = repo();
      try {
        r.write("package.json", script(cmd));
        const report = await check(r.root);
        assert.equal(of(report, "GD001").length, 1, `expected a finding for: ${cmd}`);
        assert.equal(of(report, "GD001")[0].level, "error");
        assert.match(of(report, "GD001")[0].where, /scripts\.data/);
      } finally {
        r.cleanup();
      }
    }
  });

  test("does not fire when the version is pinned, nor on an unrelated package", async () => {
    for (const cmd of [`npx ${NAME}@0.2.0 rollup`, "npx prettier --write .", `npx ${NAME}@^0.2.0 rollup`, "npm run build"]) {
      const r = repo();
      try {
        r.write("package.json", script(cmd));
        const report = await check(r.root);
        assert.deepEqual(of(report, "GD001"), [], `unexpected finding for: ${cmd}`);
      } finally {
        r.cleanup();
      }
    }
  });

  test("fires on a workflow `run:` step, and reads the file as YAML not as text", async () => {
    const r = repo();
    try {
      r.write(
        ".github/workflows/ci.yml",
        `name: CI\n# a comment mentioning npx ${NAME} must not count\njobs:\n  test:\n    steps:\n      - run: npx ${NAME} rollup --check\n`,
      );
      const report = await check(r.root);
      assert.equal(of(report, "GD001").length, 1);
      assert.match(of(report, "GD001")[0].where, /workflows\/ci\.yml/);
    } finally {
      r.cleanup();
    }
  });

  test("a multi-command run step is split, so a later invocation is still seen", async () => {
    const r = repo();
    try {
      r.write("package.json", script(`npm ci && npx ${NAME} rollup --check`));
      const report = await check(r.root);
      assert.equal(of(report, "GD001").length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("fires in a shell script, which is where CI invocations often actually live", async () => {
    const r = repo();
    try {
      r.write("scripts/data.sh", `#!/usr/bin/env bash\nset -euo pipefail\nnpx ${NAME} rollup --check\n`);
      const report = await check(r.root);
      assert.equal(of(report, "GD001").length, 1);
      assert.equal(of(report, "GD001")[0].where, "scripts/data.sh");
    } finally {
      r.cleanup();
    }
  });

  test("runCommands reads scripts, workflow run steps and shell scripts — and nothing else", () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ scripts: { a: "echo a", b: "echo b" } }));
      r.write(".github/workflows/w.yml", "jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo c\n");
      r.write("tools/x.sh", "echo d\n");
      // Deliberately NOT scanned: arbitrary source, docs, and anything under node_modules.
      r.write("src/app.js", `// npx ${NAME} rollup\n`);
      r.write("README.md", `npx ${NAME} rollup\n`);
      r.write("node_modules/dep/run.sh", `npx ${NAME} rollup\n`);
      const found = runCommands(r.root).map((c) => c.command.trim()).sort();
      assert.deepEqual(found, ["echo a", "echo b", "echo c", "echo d"]);
    } finally {
      r.cleanup();
    }
  });

  test("`scan:` replaces the default list, so a consumer can widen or narrow deliberately", async () => {
    const widened = repo();
    try {
      widened.write("Makefile", `data:\n\tnpx ${NAME} rollup\n`);
      // Not in the defaults, so nothing fires until the policy names it.
      assert.deepEqual(of(await check(widened.root), "GD001"), []);

      widened.policy("scan:\n  - Makefile\n");
      assert.equal(of(await check(widened.root), "GD001").length, 1);
    } finally {
      widened.cleanup();
    }

    const narrowed = repo();
    try {
      narrowed.write("package.json", JSON.stringify({ scripts: { x: `npx ${NAME} rollup` } }));
      assert.equal(of(await check(narrowed.root), "GD001").length, 1);

      narrowed.policy("scan:\n  - .github/workflows/*.yml\n");
      assert.deepEqual(of(await check(narrowed.root), "GD001"), []);
    } finally {
      narrowed.cleanup();
    }
  });

  test("a `scan:` that is not a list of strings is a policy defect", () => {
    const r = repo();
    try {
      r.policy("scan: package.json\n");
      assert.match(readPolicy(join(r.root, "data")).defects.join("\n"), /"scan" must be a list of path patterns/);
    } finally {
      r.cleanup();
    }
  });
});

describe("GD112 · row-contract-reimplemented", () => {
  const COPY = `
    export function isRow(name) {
      return name.endsWith(".md") && !name.startsWith("_") && name.toLowerCase() !== "readme.md";
    }
  `;

  test("fires on a hand-rolled copy of the row predicate, at warn, saying it is a heuristic", async () => {
    const r = repo();
    try {
      r.write("scripts/verify-data-store.ts", COPY);
      const report = await check(r.root);
      assert.equal(of(report, "GD112").length, 1);
      assert.equal(of(report, "GD112")[0].level, "warn");
      assert.equal(of(report, "GD112")[0].where, "scripts/verify-data-store.ts");
      assert.match(of(report, "GD112")[0].message, /THIS IS A HEURISTIC/);
    } finally {
      r.cleanup();
    }
  });

  test("sees a copy in a file that never imports gitdata — the defect the narrow design would miss", async () => {
    // The motivating case shells out to a runner, so it imports nothing. A scan restricted to
    // files importing the package would be structurally blind to it.
    const r = repo();
    try {
      r.write("scripts/verify.sh", 'ls *.md | grep -v "^_" | grep -iv readme\n');
      const report = await check(r.root);
      assert.equal(of(report, "GD112").length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("exempts the file that exports the predicate, and any file that imports it", async () => {
    const definition = repo();
    try {
      definition.write("src/load.js", `export const isRowFile = (n) => n.endsWith(".md") && !n.startsWith("_") && n.toLowerCase() !== "readme.md";`);
      assert.deepEqual(of(await check(definition.root), "GD112"), []);
    } finally {
      definition.cleanup();
    }

    for (const source of [
      `import { isRowFile } from "${NAME}";\n// .md, "_" and readme all named here, correctly\nexport const use = (n) => isRowFile(n);\n`,
      // A relative import is still a call site — the engine's own tests import it this way, and
      // the first version of this exemption flagged them.
      `import { escapedRowFiles, isRowFile, rowFilesIn } from "../src/load.js";\n// .md, "_", readme\n`,
      `const { isRowFile } = require("${NAME}");\n// .md, "_", readme\n`,
    ]) {
      const importer = repo();
      try {
        importer.write("src/tool.js", source);
        assert.deepEqual(of(await check(importer.root), "GD112"), [], `unexpected finding for:\n${source}`);
      } finally {
        importer.cleanup();
      }
    }
  });

  test("does not fire on an ordinary path test that is not a row predicate", async () => {
    const r = repo();
    try {
      r.write("src/docs.js", 'export const isDoc = (n) => n.endsWith(".md");\n');
      assert.deepEqual(of(await check(r.root), "GD112"), []);
    } finally {
      r.cleanup();
    }
  });

  test("being a warn, it fails --strict but not --check", () => {
    const r = repo();
    try {
      r.write("scripts/copy.js", COPY);
      assert.equal(run(["doctor", "--check", "--offline", "--root", r.root]).status, 0);
      assert.equal(run(["doctor", "--strict", "--offline", "--root", r.root]).status, 1);
    } finally {
      r.cleanup();
    }
  });
});

describe("GD002 · install-disagrees", () => {
  test("fires when the dependency is declared but absent from node_modules", async () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ dependencies: { [NAME]: "^0.2.0" } }));
      const report = await check(r.root);
      assert.equal(of(report, "GD002").length, 1);
      assert.match(of(report, "GD002")[0].message, /absent from node_modules/);
    } finally {
      r.cleanup();
    }
  });

  test("fires when the lockfile pins a version outside the declared range", async () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ dependencies: { [NAME]: "^0.2.0" } }));
      r.write(`node_modules/${NAME}/package.json`, JSON.stringify({ name: NAME, version: "0.1.0" }));
      r.write("package-lock.json", JSON.stringify({ packages: { [`node_modules/${NAME}`]: { version: "0.1.0" } } }));
      const report = await check(r.root);
      const messages = of(report, "GD002").map((f) => f.message).join("\n");
      assert.match(messages, /pins 0\.1\.0, outside the \^0\.2\.0/);
    } finally {
      r.cleanup();
    }
  });

  test("fires when node_modules and the lockfile disagree", async () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ dependencies: { [NAME]: "^0.2.0" } }));
      r.write(`node_modules/${NAME}/package.json`, JSON.stringify({ name: NAME, version: "0.2.0" }));
      r.write("package-lock.json", JSON.stringify({ packages: { [`node_modules/${NAME}`]: { version: "0.2.1" } } }));
      const report = await check(r.root);
      assert.match(of(report, "GD002").map((f) => f.message).join("\n"), /node_modules holds 0\.2\.0 but package-lock\.json pins 0\.2\.1/);
    } finally {
      r.cleanup();
    }
  });

  test("does not fire when manifest, lockfile and node_modules all agree", async () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ dependencies: { [NAME]: "^0.2.0" } }));
      r.write(`node_modules/${NAME}/package.json`, JSON.stringify({ name: NAME, version: "0.2.0" }));
      r.write("package-lock.json", JSON.stringify({ packages: { [`node_modules/${NAME}`]: { version: "0.2.0" } } }));
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD002"), []);
    } finally {
      r.cleanup();
    }
  });

  test("skips — never silently passes — when nothing declares the dependency", async () => {
    const r = repo();
    try {
      r.write("package.json", JSON.stringify({ name: "consumer" }));
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD002"), []);
      assert.ok(skippedIds(report).includes("GD002"));
    } finally {
      r.cleanup();
    }
  });
});

describe("GD003 · unscoped-package", () => {
  const UNSCOPED = "git" + "data";

  test("fires on a runner and on an install naming the unscoped package", async () => {
    for (const cmd of [`npx ${UNSCOPED} rollup`, `npm install ${UNSCOPED}`, `bunx ${UNSCOPED}@1.0.0 rollup`, `pnpm add ${UNSCOPED}`]) {
      const r = repo();
      try {
        r.write("package.json", JSON.stringify({ scripts: { x: cmd } }));
        const report = await check(r.root);
        assert.equal(of(report, "GD003").length, 1, `expected a finding for: ${cmd}`);
        assert.equal(of(report, "GD003")[0].level, "error");
      } finally {
        r.cleanup();
      }
    }
  });

  test("does not fire on the scoped name, nor on a locally-installed binary", async () => {
    // A bare command in a script resolves to node_modules/.bin — that is the LOCAL install, not
    // the stranger's registry package, and flagging it would be a false positive on correct usage.
    for (const cmd of [`npx ${NAME}@0.2.0 rollup`, `${UNSCOPED} rollup --check`, `npm install ${NAME}@0.2.0`]) {
      const r = repo();
      try {
        r.write("package.json", JSON.stringify({ scripts: { x: cmd } }));
        const report = await check(r.root);
        assert.deepEqual(of(report, "GD003"), [], `unexpected finding for: ${cmd}`);
      } finally {
        r.cleanup();
      }
    }
  });
});

describe("GD004 · behind-latest", () => {
  test("warns when the installed version is behind the published one", async () => {
    const r = repo();
    try {
      r.write(`node_modules/${NAME}/package.json`, JSON.stringify({ name: NAME, version: "0.1.0" }));
      const report = await doctor({ root: r.root, fetchLatest: latest("0.9.0") });
      assert.equal(of(report, "GD004").length, 1);
      assert.equal(of(report, "GD004")[0].level, "warn");
      assert.match(of(report, "GD004")[0].message, /0\.1\.0 is installed; 0\.9\.0 is published/);
    } finally {
      r.cleanup();
    }
  });

  test("does not warn when current", async () => {
    const r = repo();
    try {
      r.write(`node_modules/${NAME}/package.json`, JSON.stringify({ name: NAME, version: "0.9.0" }));
      const report = await doctor({ root: r.root, fetchLatest: latest("0.9.0") });
      assert.deepEqual(of(report, "GD004"), []);
    } finally {
      r.cleanup();
    }
  });

  test("--offline skips it, and an unreachable registry skips it — neither is a pass", async () => {
    const r = repo();
    try {
      const offline = await doctor({ root: r.root, offline: true, fetchLatest: latest("9.9.9") });
      assert.deepEqual(of(offline, "GD004"), []);
      assert.match(offline.skipped.find((s) => s.id === "GD004").reason, /--offline/);

      const unreachable = await doctor({ root: r.root, fetchLatest: noLatest });
      assert.deepEqual(of(unreachable, "GD004"), []);
      assert.match(unreachable.skipped.find((s) => s.id === "GD004").reason, /UNKNOWN/);
    } finally {
      r.cleanup();
    }
  });
});

describe("GD005 · pack-engine-range", () => {
  const packs = (...list) => () => list;

  test("skips cleanly — never errors — when no receipt records what is installed", async () => {
    const r = repo();
    try {
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD005"), []);
      assert.match(report.skipped.find((s) => s.id === "GD005").reason, /no pack receipt/);
    } finally {
      r.cleanup();
    }
  });

  test("fires when an installed pack's requires: excludes the running engine", async () => {
    const r = repo();
    try {
      r.policy("packs:\n  demo: 1.0.0\n");
      const report = await check(r.root, { bundledPacks: packs({ name: "demo", version: "1.0.0", requires: ">=99.0.0" }) });
      assert.equal(of(report, "GD005").length, 1);
      assert.equal(of(report, "GD005")[0].level, "error");
      assert.match(of(report, "GD005")[0].message, /requires engine >=99\.0\.0/);
    } finally {
      r.cleanup();
    }
  });

  test("does not fire when the range admits the running engine", async () => {
    const r = repo();
    try {
      r.policy("packs:\n  demo: 1.0.0\n");
      const report = await check(r.root, { bundledPacks: packs({ name: "demo", version: "1.0.0", requires: ">=0.0.1" }) });
      assert.deepEqual(of(report, "GD005"), []);
      assert.ok(!skippedIds(report).includes("GD005"));
    } finally {
      r.cleanup();
    }
  });

  test("a pack whose manifest cannot be read is UNKNOWN, not a pass", async () => {
    const r = repo();
    try {
      r.policy("packs:\n  demo: 1.0.0\n  absent: 2.0.0\n");
      const report = await check(r.root, { bundledPacks: packs({ name: "demo", version: "3.0.0", requires: ">=0.0.1" }) });
      assert.deepEqual(of(report, "GD005"), []);
      const reasons = report.skipped.filter((s) => s.id === "GD005").map((s) => s.reason).join("\n");
      assert.match(reasons, /pack "absent" is not bundled with this engine/);
      assert.match(reasons, /pack "demo" 1\.0\.0 is recorded installed; this engine bundles 3\.0\.0/);
    } finally {
      r.cleanup();
    }
  });

  test("the bundled pack satisfies the engine it ships with — the dogfood case", async () => {
    const r = repo();
    try {
      r.policy(`packs:\n  feature-management: ${readFileSync(join(REPO, "packs/feature-management/pack.yml"), "utf8").match(/^version:\s*(\S+)/m)[1]}\n`);
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD005"), []);
      assert.ok(!skippedIds(report).includes("GD005"), "the bundled pack should be readable, not UNKNOWN");
    } finally {
      r.cleanup();
    }
  });
});

describe("GD006 · node-below-engines", () => {
  test("fires when the running node is below engines.node", async () => {
    const r = repo();
    try {
      const report = await check(r.root, { nodeVersion: "18.0.0" });
      assert.equal(of(report, "GD006").length, 1);
      assert.equal(of(report, "GD006")[0].level, "error");
      assert.match(of(report, "GD006")[0].message, /node 18\.0\.0 is running/);
    } finally {
      r.cleanup();
    }
  });

  test("does not fire on the node this suite is running on", async () => {
    const r = repo();
    try {
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD006"), [], "the test runner's node is outside the declared engines range");
    } finally {
      r.cleanup();
    }
  });
});

describe("GD007 · engine-range-unsatisfied", () => {
  test("fires when the store declares a range this engine is outside of", async () => {
    const r = repo();
    try {
      r.policy('engine: ">=99.0.0"\n');
      const report = await check(r.root);
      assert.equal(of(report, "GD007").length, 1);
      assert.match(of(report, "GD007")[0].message, /declares engine >=99\.0\.0/);
    } finally {
      r.cleanup();
    }
  });

  test("does not fire when the range admits it; an unreadable range is a finding; absent is skipped", async () => {
    const ok = repo();
    try {
      ok.policy('engine: ">=0.0.1"\n');
      assert.deepEqual(of(await check(ok.root), "GD007"), []);
    } finally {
      ok.cleanup();
    }

    const bad = repo();
    try {
      bad.policy('engine: "not a range"\n');
      const report = await check(bad.root);
      assert.equal(of(report, "GD007").length, 1);
      assert.match(of(report, "GD007")[0].message, /not a readable version range/);
    } finally {
      bad.cleanup();
    }

    const none = repo();
    try {
      const report = await check(none.root);
      assert.deepEqual(of(report, "GD007"), []);
      assert.ok(skippedIds(report).includes("GD007"));
    } finally {
      none.cleanup();
    }
  });
});

describe("GD103 · artifact-lands-in-a-table", () => {
  const view = (out) =>
    `id: v\nout: ${out}\nqueries:\n  rows: "SELECT id AS line FROM things"\ntemplate: |\n  {{rows}}\n`;

  test("fires when a view writes into a table directory, where load() would read it back", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/_views/v.view.yml", view("data/things/board.md"));
      const report = await check(r.root);
      assert.equal(of(report, "GD103").length, 1);
      assert.equal(of(report, "GD103")[0].level, "error");
      assert.match(of(report, "GD103")[0].message, /writes into the "things" table/);
    } finally {
      r.cleanup();
    }
  });

  test("fires for a nested shard path too — a table may nest, so depth does not save it", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/_views/v.view.yml", view("data/things/2026/01/board.md"));
      assert.equal(of(await check(r.root), "GD103").length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("does NOT fire on the shipped convention: data/_views/, an `_`-prefixed name, or outside data/", async () => {
    // The predicate that fires on `data/_views/board.md` would fail this project's own pack.
    for (const out of ["data/_views/board.md", "data/things/_board.md", "docs/board.md", "data/board.md", "data/things/board.txt"]) {
      const r = repo();
      try {
        r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
        r.write("data/_views/v.view.yml", view(out));
        assert.deepEqual(of(await check(r.root), "GD103"), [], `unexpected finding for out: ${out}`);
      } finally {
        r.cleanup();
      }
    }
  });

  test("the bundled pack passes its own check", async () => {
    const r = repo();
    try {
      const init = run(["init", "--pack", "feature-management", "--root", r.root]);
      assert.equal(init.status, 0, init.stderr);
      assert.deepEqual(of(await check(r.root), "GD103"), []);
    } finally {
      r.cleanup();
    }
  });
});

describe("GD109 · rollup-drift (delegated)", () => {
  test("fires on a missing artifact and on a hand-edited one, and clears after a rollup", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/v.view.yml",
        'id: v\nout: data/_views/v.md\nqueries:\n  rows: "SELECT id AS line FROM things"\ntemplate: |\n  {{rows}}\n',
      );

      const missing = await check(r.root);
      assert.equal(of(missing, "GD109").length, 1);
      assert.match(of(missing, "GD109")[0].message, /is missing/);

      assert.equal(run(["rollup", "--root", r.root]).status, 0);
      assert.deepEqual(of(await check(r.root), "GD109"), []);

      writeFileSync(join(r.root, "data/_views/v.md"), "vandalism\n");
      const drifted = await check(r.root);
      assert.equal(of(drifted, "GD109").length, 1);
      assert.match(of(drifted, "GD109")[0].message, /is drifted/);
    } finally {
      r.cleanup();
    }
  });

  test("a broken view spec is a finding, never a stack trace — doctor must not crash", async () => {
    const r = repo();
    try {
      r.write("data/_views/v.view.yml", "id: v\n");
      const report = await check(r.root);
      assert.equal(of(report, "GD109").length, 1);
      assert.match(of(report, "GD109")[0].message, /rollup could not run/);
    } finally {
      r.cleanup();
    }
  });

  test("skips when there are no views at all", async () => {
    const r = repo();
    try {
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD109"), []);
      assert.ok(skippedIds(report).includes("GD109"));
    } finally {
      r.cleanup();
    }
  });
});

describe("GD110 · validate-issues (delegated)", () => {
  test("fires on a row that breaks its schema, and clears when the row is fixed", async () => {
    const r = repo();
    try {
      r.write("data/_schema/things.schema.yml", "required: [id, title]\nunique: [id]\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(r.root);
      assert.equal(of(report, "GD110").length, 1);
      assert.match(of(report, "GD110")[0].message, /things: required — missing "title"/);
      assert.equal(of(report, "GD110")[0].where, "data/things/a.md");

      r.write("data/things/a.md", "---\nid: T-1\ntitle: A\n---\nA.\n");
      assert.deepEqual(of(await check(r.root), "GD110"), []);
    } finally {
      r.cleanup();
    }
  });

  test("skips when no schema opts in", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD110"), []);
      assert.ok(skippedIds(report).includes("GD110"));
    } finally {
      r.cleanup();
    }
  });
});

describe("GD111 · measured-without-provenance", () => {
  test("warns on a measured row carrying none of the declared provenance columns", async () => {
    const r = repo();
    try {
      r.policy("tables:\n  things: { class: measured, written_by: \"an extract script\", provenance: [source_sha] }\n");
      r.write("data/things/a.md", "---\nid: T-1\nsource_sha: 8c1f0e2a3b4c5d6e7f8091a2b3c4d5e6f7081920\n---\nA.\n");
      r.write("data/things/b.md", "---\nid: T-2\n---\nB.\n");
      const report = await check(r.root);
      assert.equal(of(report, "GD111").length, 1);
      assert.equal(of(report, "GD111")[0].level, "warn");
      assert.equal(of(report, "GD111")[0].where, "data/things/b.md");
    } finally {
      r.cleanup();
    }
  });

  test("does not warn when every measured row carries provenance", async () => {
    const r = repo();
    try {
      r.policy("tables:\n  things: { class: measured, provenance: [source_sha] }\n");
      r.write("data/things/a.md", "---\nid: T-1\nsource_sha: abc\n---\nA.\n");
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD111"), []);
    } finally {
      r.cleanup();
    }
  });

  test("a measured table declaring no provenance columns is itself the finding", async () => {
    const r = repo();
    try {
      r.policy("tables:\n  things: { class: measured }\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(r.root);
      assert.equal(of(report, "GD111").length, 1);
      assert.match(of(report, "GD111")[0].message, /declares no `provenance:` columns/);
    } finally {
      r.cleanup();
    }
  });

  test("an authored table is not checked for provenance", async () => {
    const r = repo();
    try {
      r.policy("tables:\n  things: { class: authored }\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD111"), []);
    } finally {
      r.cleanup();
    }
  });

  test("FAIL-OPEN IS NOT ACCEPTABLE: no `class:` skips and says so, it never passes silently", async () => {
    const undeclared = repo();
    try {
      undeclared.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(undeclared.root);
      assert.deepEqual(of(report, "GD111"), []);
      assert.match(report.skipped.find((s) => s.id === "GD111").reason, /every table's class is UNKNOWN/);
    } finally {
      undeclared.cleanup();
    }

    const partial = repo();
    try {
      partial.policy("tables:\n  things: { written_by: \"a script\" }\n  other: { class: authored }\n");
      partial.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const report = await check(partial.root);
      const reasons = report.skipped.filter((s) => s.id === "GD111").map((s) => s.reason).join("\n");
      assert.match(reasons, /declared with no `class:`, so unchecked: things/);
    } finally {
      partial.cleanup();
    }
  });

  test("a measured table with no directory is reported unchecked, not passed", async () => {
    const r = repo();
    try {
      r.policy("tables:\n  ghosts: { class: measured, provenance: [source_sha] }\n");
      const report = await check(r.root);
      assert.deepEqual(of(report, "GD111"), []);
      assert.match(report.skipped.filter((s) => s.id === "GD111").map((s) => s.reason).join("\n"), /has no directory under data\//);
    } finally {
      r.cleanup();
    }
  });
});

describe("the exit-code matrix", () => {
  test("exitCode() is the whole contract", () => {
    const s = (error, warn, off = 0) => ({ error, warn, off });
    // No flags: always 0, whatever was found. A dev shell is never broken by a report.
    assert.equal(exitCode(s(9, 9, 9)), 0);
    // --check: errors only.
    assert.equal(exitCode(s(0, 0), { check: true }), 0);
    assert.equal(exitCode(s(0, 3), { check: true }), 0);
    assert.equal(exitCode(s(1, 0), { check: true }), 1);
    // --strict: --check plus warnings.
    assert.equal(exitCode(s(0, 0), { strict: true }), 0);
    assert.equal(exitCode(s(0, 1), { strict: true }), 1);
    assert.equal(exitCode(s(1, 0), { strict: true }), 1);
    // `off` never fails anything — which is exactly why lowering to it requires a reason.
    assert.equal(exitCode(s(0, 0, 5), { check: true }), 0);
    assert.equal(exitCode(s(0, 0, 5), { strict: true }), 0);
  });

  test("spawned: an error exits 0 bare, 1 under --check, 1 under --strict", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/v.view.yml",
        'id: v\nout: data/_views/v.md\nqueries:\n  rows: "SELECT id AS line FROM things"\ntemplate: |\n  {{rows}}\n',
      );

      const bare = run(["doctor", "--offline", "--root", r.root]);
      assert.equal(bare.status, 0, bare.stderr);
      assert.match(bare.stdout, /GD109/);

      assert.equal(run(["doctor", "--check", "--offline", "--root", r.root]).status, 1);
      assert.equal(run(["doctor", "--strict", "--offline", "--root", r.root]).status, 1);
    } finally {
      r.cleanup();
    }
  });

  test("spawned: a warning alone passes --check and fails --strict", () => {
    const r = repo();
    try {
      r.policy("tables:\n  things: { class: measured }\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");

      assert.equal(run(["doctor", "--offline", "--root", r.root]).status, 0);
      const checked = run(["doctor", "--check", "--offline", "--root", r.root]);
      assert.equal(checked.status, 0, checked.stdout);
      assert.match(checked.stdout, /GD111/);
      assert.equal(run(["doctor", "--strict", "--offline", "--root", r.root]).status, 1);
    } finally {
      r.cleanup();
    }
  });

  test("spawned: a silenced check fails nothing, and is printed with its reason", () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/v.view.yml",
        'id: v\nout: data/_views/v.md\nqueries:\n  rows: "SELECT id AS line FROM things"\ntemplate: |\n  {{rows}}\n',
      );
      r.policy('checks:\n  GD109: { level: off, reason: "built by another job" }\n');

      const r1 = run(["doctor", "--strict", "--offline", "--root", r.root]);
      assert.equal(r1.status, 0, r1.stdout);
      assert.match(r1.stdout, /silenced by policy/);
      assert.match(r1.stdout, /GD109\s+error → off\s+1 finding\(s\)\s+built by another job/);
    } finally {
      r.cleanup();
    }
  });
});

describe("--json", () => {
  test("emits findings and a summary keyed by level", () => {
    const r = repo();
    try {
      r.write("data/_schema/things.schema.yml", "required: [title]\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      const out = run(["doctor", "--json", "--offline", "--root", r.root]);
      assert.equal(out.status, 0, out.stderr);
      const parsed = JSON.parse(out.stdout);
      assert.ok(Array.isArray(parsed.findings));
      assert.deepEqual(Object.keys(parsed.summary).sort(), ["error", "off", "warn"]);
      assert.equal(parsed.summary.error, 1);
      assert.equal(parsed.findings[0].id, "GD110");
      assert.equal(parsed.findings[0].check, "validate-issues");
      assert.equal(parsed.findings[0].level, "error");
      assert.ok(Array.isArray(parsed.skipped));
      assert.ok(Array.isArray(parsed.silenced));
    } finally {
      r.cleanup();
    }
  });

  test("--json output is byte-identical across runs — a report is deterministic", () => {
    const r = repo();
    try {
      r.write("data/_schema/things.schema.yml", "required: [title, owner]\n");
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write("data/things/b.md", "---\nid: T-2\n---\nB.\n");
      const a = run(["doctor", "--json", "--offline", "--root", r.root]);
      const b = run(["doctor", "--json", "--offline", "--root", r.root]);
      assert.equal(a.stdout, b.stdout);
    } finally {
      r.cleanup();
    }
  });
});

describe("doctor writes nothing", () => {
  test("a full run leaves the tree byte-identical", async () => {
    const r = repo();
    try {
      r.write("data/things/a.md", "---\nid: T-1\n---\nA.\n");
      r.write(
        "data/_views/v.view.yml",
        'id: v\nout: data/_views/v.md\nqueries:\n  rows: "SELECT id AS line FROM things"\ntemplate: |\n  {{rows}}\n',
      );
      r.write("data/_schema/things.schema.yml", "required: [title]\n");
      r.policy('engine: ">=0.0.1"\n');

      const snapshot = () => {
        const walk = (dir) =>
          readdirSync(dir)
            .sort()
            .flatMap((e) => {
              const p = join(dir, e);
              return statSync(p).isDirectory() ? walk(p) : [`${p}:${readFileSync(p, "utf8")}`];
            });
        return walk(r.root).join("\n");
      };

      const before = snapshot();
      await check(r.root);
      assert.equal(snapshot(), before, "doctor modified the tree");
    } finally {
      r.cleanup();
    }
  });
});

describe("dogfood: the shipped pack passes the tool's own compliance verb", () => {
  test("init --pack → copy the template → rollup → doctor reports zero errors", () => {
    // The test that stops upstream shipping a convention its own pack violates. The steps are the
    // pack's own documented quickstart; doctor at the end of it must be clean.
    const r = repo("gitdata-doctor-dogfood-");
    try {
      const init = run(["init", "--pack", "feature-management", "--root", r.root]);
      assert.equal(init.status, 0, init.stderr);

      copyFileSync(join(r.root, "data/features/_template.md"), join(r.root, "data/features/F-001--first.md"));
      const rolled = run(["rollup", "--root", r.root]);
      assert.equal(rolled.status, 0, rolled.stderr);

      const doc = run(["doctor", "--strict", "--offline", "--root", r.root]);
      assert.equal(doc.status, 0, `doctor was not clean on the shipped pack:\n${doc.stdout}\n${doc.stderr}`);
      assert.match(doc.stdout, /0 error\(s\), 0 warning\(s\)/);
    } finally {
      r.cleanup();
    }
  });

  test("immediately after init, before any rollup, doctor reports the un-rolled artifact", () => {
    // Proof the delegation is real rather than decorative: GD109 is the missing artifact, and the
    // fix is the documented next step, not a change to the pack.
    const r = repo("gitdata-doctor-fresh-");
    try {
      assert.equal(run(["init", "--pack", "feature-management", "--root", r.root]).status, 0);
      const doc = run(["doctor", "--offline", "--root", r.root]);
      assert.equal(doc.status, 0, "a bare doctor must exit 0 even when it finds an error");
      assert.match(doc.stdout, /GD109/);
    } finally {
      r.cleanup();
    }
  });

  test("this repository passes its own doctor, warnings included", () => {
    // --strict, not --check: a tool that had to grant itself an exemption from its own warnings
    // would be publishing a convention it does not keep.
    const doc = run(["doctor", "--strict", "--offline", "--root", REPO]);
    assert.equal(doc.status, 0, `gitdata does not pass its own doctor:\n${doc.stdout}`);
  });
});
