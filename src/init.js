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

/**
 * @param {{root: string, pack: string}} opts
 * @returns {{pack: string, written: string[], skipped: string[]}}
 */
export function init({ root, pack }) {
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
