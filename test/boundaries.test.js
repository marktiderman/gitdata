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

const files = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : extname(p) === ".js" ? [p] : [];
  });

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

  test("no shipped pack is named for a specific organisation", () => {
    // A pack is a vocabulary anyone could adopt. One named for its author's own project is a
    // private artifact that happens to live here, and it teaches new readers the wrong thing.
    for (const name of readdirSync(PACKS)) {
      for (const word of CONSUMER_WORDS) {
        assert.ok(!name.toLowerCase().includes(word), `pack "${name}" is named for a consumer`);
      }
    }
  });

  test("every pack declares a name, version and engine range", () => {
    for (const name of readdirSync(PACKS)) {
      const manifest = join(PACKS, name, "pack.yml");
      assert.ok(existsSync(manifest), `packs/${name} has no pack.yml`);
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

  test("packs depend on the engine, never the reverse", () => {
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(REPO.length + 1);
      // init.js legitimately reads packs/ from disk; nothing may *import* from one.
      assert.ok(!/from\s+["'].*\/packs\//.test(text), `${rel} imports from packs/`);
    }
  });
});
