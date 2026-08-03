/**
 * Layer-boundary tests — the rules in docs/ARCHITECTURE.md, made mechanical.
 *
 * Vocabulary does not leak in one commit; it leaks one comment at a time, usually while porting a
 * view from the repo that motivated the feature. These tests are the ratchet.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { parse as parseYaml } from "yaml";

import { SHAPES } from "../src/shapes/index.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");
const PACKS = join(REPO, "packs");

const filesWithExt = (dir, ext) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? filesWithExt(p, ext) : extname(p) === ext ? [p] : [];
  });

const files = (dir) => filesWithExt(dir, ".js");

/**
 * A pack is a directory holding a `pack.yml` — the same rule `listPacks` applies in src/init.js.
 * Enumerating `packs/` by hand instead treats a stray `README.md` as a pack and throws when the
 * directory is absent.
 */
const packDirs = () =>
  existsSync(PACKS)
    ? readdirSync(PACKS, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(PACKS, e.name, "pack.yml")))
        .map((e) => e.name)
        .sort()
    : [];

/** Public prose that a new reader meets first. Vocabulary leaks here as readily as in code. */
const PUBLIC_DOCS = ["README.md", "SHAPES.md", "CONTRIBUTING.md", "docs/ARCHITECTURE.md"];

/**
 * Words that name somebody's data rather than a mechanism. A consumer's vocabulary in the engine
 * means the engine has learned something only one repo could have taught it.
 *
 * Deliberately not a list of every possible domain word — it is a tripwire for the specific way
 * this has gone wrong before: porting a view and carrying its nouns along with it.
 */
const CONSUMER_WORDS = [
  "genesis",
  "cleanse",
  "territor",
  "ccp",
  "roadmap",
  "sprint",
  "standup",
  "okr",
];

describe("layer boundaries", () => {
  test("the engine and shapes name no consumer vocabulary", () => {
    const offenders = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const word of CONSUMER_WORDS) {
        if (text.includes(word)) offenders.push(`${file.slice(REPO.length + 1)}: "${word}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `consumer vocabulary found in src/ — see docs/ARCHITECTURE.md rule 1:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("the public docs name no consumer vocabulary", () => {
    // Caught a real leak: SHAPES.md credited each shape to the private repo whose view motivated
    // it, which says nothing to an outside reader and names somebody's internals in public prose.
    const offenders = [];
    for (const rel of PUBLIC_DOCS) {
      const text = readFileSync(join(REPO, rel), "utf8").toLowerCase();
      for (const word of CONSUMER_WORDS) {
        if (text.includes(word)) offenders.push(`${rel}: "${word}"`);
      }
    }
    assert.deepEqual(offenders, [], `consumer vocabulary in public docs:\n  ${offenders.join("\n  ")}`);
  });

  test("no shipped pack is named for a specific organisation", () => {
    // A pack is a vocabulary anyone could adopt. One named for its author's own project is a
    // private artifact that happens to live here, and it teaches new readers the wrong thing.
    for (const name of packDirs()) {
      for (const word of CONSUMER_WORDS) {
        assert.ok(!name.toLowerCase().includes(word), `pack "${name}" is named for a consumer`);
      }
    }
  });

  test("every pack declares a name, version and engine range", () => {
    for (const name of packDirs()) {
      const manifest = join(PACKS, name, "pack.yml");
      const pack = parseYaml(readFileSync(manifest, "utf8"));
      assert.equal(pack.name, name, `packs/${name}: name disagrees with its folder`);
      assert.match(String(pack.version ?? ""), /^\d+\.\d+\.\d+$/, `packs/${name}: needs a semver version`);
      assert.ok(pack.requires, `packs/${name}: needs \`requires:\` (engine range)`);
    }
  });

  test("every shape module is registered", () => {
    // The defect this exists to prevent: a shape module that no view spec can reach, because
    // nothing imported it into the registry.
    const helpers = new Set(["index.js", "sql.js"]);
    const modules = readdirSync(join(SRC, "shapes"))
      .filter((f) => f.endsWith(".js") && !helpers.has(f))
      .map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(modules.sort(), Object.keys(SHAPES).sort());
  });

  test("SHAPES.md documents exactly the registered shapes", () => {
    // Docs drift is the failure gitdata exists to catch; the tool holds itself to it.
    const documented = readFileSync(join(REPO, "SHAPES.md"), "utf8")
      .split("\n")
      .map((line) => /^\|\s*`(\w+)`\s*\|/.exec(line)?.[1])
      .filter(Boolean);
    assert.deepEqual(documented.sort(), Object.keys(SHAPES).sort());
  });

  test("bundled pack views declare shapes, not SQL", () => {
    // A shipped pack is a worked example. If one needs raw SQL to say what it means, a shape is
    // missing — and SHAPES.md's claim about the packs goes stale the moment this stops holding.
    for (const name of packDirs()) {
      const viewsDir = join(PACKS, name, "files", "data", "_views");
      if (!existsSync(viewsDir)) continue;
      for (const file of readdirSync(viewsDir).filter((f) => f.endsWith(".view.yml"))) {
        const spec = parseYaml(readFileSync(join(viewsDir, file), "utf8"));
        for (const [queryName, q] of Object.entries(spec.queries ?? {})) {
          const at = `packs/${name}/${file}: query "${queryName}"`;
          assert.notEqual(typeof q, "string", `${at} is raw SQL — declare a shape`);
          assert.ok(q && typeof q === "object", `${at} must be a shape declaration`);
          assert.ok(
            Object.hasOwn(SHAPES, q.shape),
            `${at} declares unregistered shape "${q.shape}" — available: ${Object.keys(SHAPES).join(", ")}`,
          );
        }
      }
    }
  });

  test("packs depend on the engine, never the reverse", () => {
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(REPO.length + 1);
      // init.js legitimately reads packs/ from disk; nothing may *import* from one.
      assert.ok(
        !/(?:from|import|require)\s*\(?\s*["'][^"']*\/packs\//.test(text),
        `${rel} imports from packs/`,
      );
    }
  });
});
