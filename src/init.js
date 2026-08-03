/**
 * `gitdata init` — scaffold a pack's tables, templates and views into a repo.
 *
 * A pack is a directory whose `files/` tree is copied into the target root. Nothing is
 * generated: what lands on disk is what shipped, so a consumer can read the pack in the repo
 * and know exactly what they will get.
 *
 * Two guarantees:
 *   idempotent — re-running writes nothing new
 *   row-safe   — an existing file is NEVER overwritten. Templates and views are yours the
 *                moment they land; editing them is the point, not a fork.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const PACKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packs");

export class PackError extends Error {}

export function listPacks() {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR)
    .filter((name) => existsSync(join(PACKS_DIR, name, "pack.yml")))
    .sort()
    .map((name) => ({ name, ...parseYaml(readFileSync(join(PACKS_DIR, name, "pack.yml"), "utf8")) }));
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

/** What a bare `data/` needs to exist, be committable, and explain itself. */
const BARE_README = `# data/

The gitdata trellis for this repo.

**folder = table · file = row · frontmatter = columns.**

Every \`.md\` file directly inside a table folder is a row; its frontmatter keys become that
table's columns. Files and folders prefixed with \`_\` are never rows (\`_template.md\`,
\`_views/\`, \`_schema/\`), and \`README.md\` documents rather than participates.

Add a table by making a folder and putting a row in it — no declaration step:

    mkdir -p data/things
    printf -- '---\\nid: T-001\\ntitle: First thing\\n---\\n' > data/things/T-001--first.md

Add a view by writing \`data/_views/<id>.view.yml\`, then:

    gitdata rollup          # regenerate every view
    gitdata rollup --check  # CI: fail if an artifact drifted from its sources

A generated artifact is never hand-edited — \`rollup --check\` exists to catch exactly that.
`;

/**
 * Scaffold the minimum trellis: a `data/` root and a place for views.
 *
 * The engine needs no tables to work — column discovery is the union of whatever frontmatter it
 * finds — so a consumer bringing its own vocabulary should not have to install someone else's
 * table list to get started. Without this, `init` demanded `--pack` and the only paths into
 * gitdata were another repo's content model or hand-made folders.
 */
function initBare(root) {
  const written = [];
  const skipped = [];
  for (const [rel, body] of [
    ["data/README.md", BARE_README],
    ["data/_views/.gitkeep", ""],
  ]) {
    const dest = join(resolve(root), rel);
    if (existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    written.push(rel);
  }
  return { pack: null, written, skipped };
}

/**
 * @param {{root: string, pack?: string|null}} opts
 * @returns {{pack: string|null, written: string[], skipped: string[]}}
 */
export function init({ root, pack }) {
  if (!pack) return initBare(root);

  const packDir = join(PACKS_DIR, pack);
  if (!existsSync(join(packDir, "pack.yml"))) {
    const available = listPacks().map((p) => p.name);
    throw new PackError(
      `unknown pack "${pack}"${available.length ? ` — available: ${available.join(", ")}` : ""}`,
    );
  }

  const filesDir = join(packDir, "files");
  const written = [];
  const skipped = [];

  for (const rel of walk(filesDir).sort()) {
    const dest = join(resolve(root), rel);
    if (existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(filesDir, rel), dest);
    written.push(rel);
  }

  // A table folder with no rows yet must survive `git add`, or the trellis vanishes on clone.
  for (const table of parseYaml(readFileSync(join(packDir, "pack.yml"), "utf8")).tables ?? []) {
    const keep = join(resolve(root), "data", table, ".gitkeep");
    if (!existsSync(keep)) {
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, "");
      written.push(relative(resolve(root), keep));
    }
  }

  return { pack, written, skipped };
}
