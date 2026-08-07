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
import { dirname, join, relative, resolve, sep } from "node:path";
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

/**
 * What a bare data root needs to exist, be committable, and explain itself.
 *
 * Every path is written out of the root the caller actually chose, because this file's whole job
 * is to tell the next reader where their rows go. Hard-coding `data/` here would hand a second,
 * separately-owned store a README that describes the first one — and the reader who follows it
 * puts their rows in somebody else's table.
 *
 * `at` is the data root relative to the repo, and `run` is the flag needed to reach it (empty for
 * the default root, which every command already finds on its own).
 */
const bareReadme = (at, run) => `# ${at}/

The gitdata trellis for this repo.

**folder = table · file = row · frontmatter = columns.**

Every \`.md\` file directly inside a table folder is a row; its frontmatter keys become that
table's columns. Files and folders prefixed with \`_\` are never rows (\`_template.md\`,
\`_views/\`, \`_schema/\`), and \`README.md\` documents rather than participates.

Add a table by making a folder and putting a row in it — no declaration step:

    mkdir -p ${at}/things
    printf -- '---\\nid: T-001\\ntitle: First thing\\n---\\n' > ${at}/things/T-001--first.md

Add a view by writing \`${at}/_views/<id>.view.yml\`, then:

    gitdata rollup${run}          # regenerate every view
    gitdata rollup${run} --check  # CI: fail if an artifact drifted from its sources

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
function initBare(repoRoot, dataDir) {
  // The paths this README prints are shell commands somebody will paste, so they are spelled with
  // `/` whatever the platform's separator is.
  const at = relative(repoRoot, dataDir).split(sep).join("/");
  const run = dataDir === join(repoRoot, "data") ? "" : ` --data ${at}`;

  const written = [];
  const skipped = [];
  for (const [rel, body] of [
    [join(at, "README.md"), bareReadme(at, run)],
    [join(at, "_views", ".gitkeep"), ""],
  ]) {
    const dest = join(repoRoot, rel);
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
 * @param {{root: string, pack?: string|null, dataRoot?: string|null}} opts `dataRoot` defaults to
 *   `<root>/data`; a relative value resolves against `root`.
 * @returns {{pack: string|null, written: string[], skipped: string[]}}
 */
export function init({ root, pack, dataRoot = null }) {
  const repoRoot = resolve(root);
  const dataDir = dataRoot === null ? join(repoRoot, "data") : resolve(repoRoot, dataRoot);

  if (!pack) return initBare(repoRoot, dataDir);

  const packDir = join(PACKS_DIR, pack);
  if (!existsSync(join(packDir, "pack.yml"))) {
    const available = listPacks().map((p) => p.name);
    throw new PackError(
      `unknown pack "${pack}"${available.length ? ` — available: ${available.join(", ")}` : ""}`,
    );
  }

  // A pack's `files/` tree is copied VERBATIM — that is the guarantee that lets a consumer read
  // the pack in this repo and know exactly what will land. Every path in it, the prose inside its
  // README and template, and its view spec's `out:` all say `data/`, so honouring a different data
  // root here would mean rewriting shipped content, which `init` does not do. Copying it unchanged
  // is worse than refusing: the tables would land under the chosen root while the view spec beside
  // them still wrote its artifact under `data/`, and a second pack installed at a third root would
  // declare the same `out:` and silently overwrite the first one's board. Scaffold the root bare
  // (`init --data <dir>` with no pack) and write the view against it.
  if (dataDir !== join(repoRoot, "data")) {
    throw new PackError(
      `a pack installs into <root>/data — it cannot be combined with a different data root (${relative(repoRoot, dataDir)}). ` +
        "Its files, prose and view `out:` name `data/` and are copied verbatim. " +
        "Run `init` without --pack to scaffold that root bare.",
    );
  }

  const filesDir = join(packDir, "files");
  const written = [];
  const skipped = [];

  for (const rel of walk(filesDir).sort()) {
    const dest = join(repoRoot, rel);
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
    const keep = join(dataDir, table, ".gitkeep");
    if (!existsSync(keep)) {
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, "");
      written.push(relative(repoRoot, keep));
    } else {
      // Re-runs must account for every file the first run wrote, or "0 written, 3 left alone"
      // silently loses one from the books.
      skipped.push(relative(repoRoot, keep));
    }
  }

  return { pack, written, skipped };
}
