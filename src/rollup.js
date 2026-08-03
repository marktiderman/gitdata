/**
 * The rollup: read views, run their queries, render, write — or check for drift.
 *
 * `rollup()` regenerates every view. `rollup({ check: true })` compiles in memory and compares
 * against what is committed without writing, which is the driftproof guarantee: a hand-edited
 * artifact, or a source edit without a regenerate, fails the check.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

import { parse as parseYaml } from "yaml";

import { load } from "./load.js";
import { project, query } from "./project.js";
import { renderTemplate } from "./render.js";
import { runShape } from "./shapes/index.js";

export class ViewSpecError extends Error {}

/**
 * Resolve a view's `out:` and refuse to leave the repo.
 *
 * `out: ../../x.md` otherwise writes wherever the process can reach — a typo silently drops a
 * file outside the project, and an installed third-party pack could target `~/.bashrc`. A rollup
 * only ever writes artifacts belonging to the repo it was pointed at.
 */
function resolveOut(repoRoot, out, specFile) {
  const base = resolve(repoRoot);
  const target = resolve(base, out);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ViewSpecError(`${specFile}: "out" escapes the repo root — ${out}`);
  }
  return target;
}

/** Read `<root>/_views/*.view.yml`, sorted by id for deterministic reporting. */
export function loadViewSpecs(dataRoot) {
  const dir = join(dataRoot, "_views");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".view.yml"))
    .sort()
    .map((file) => {
      const spec = parseYaml(readFileSync(join(dir, file), "utf8"));
      for (const field of ["id", "out", "queries", "template"]) {
        if (!spec?.[field]) throw new ViewSpecError(`${file}: missing required field "${field}"`);
      }
      return { ...spec, _file: file };
    });
}

/**
 * Compile one view to its final text without touching disk.
 *
 * A `queries:` entry is either raw SQL (a string) or a shape declaration (a mapping with
 * `shape:`). Both yield rows whose first column is a line, so the renderer cannot tell them
 * apart and a view may mix the two.
 */
export function compileView(db, spec) {
  const results = {};
  for (const [name, q] of Object.entries(spec.queries)) {
    results[name] = typeof q === "string" ? query(db, q) : runShape(db, q);
  }
  return renderTemplate(spec.template, results);
}

/**
 * @param {{dataRoot: string, repoRoot: string, check?: boolean}} opts
 * @returns {Promise<Array<{id: string, out: string, status: "written"|"unchanged"|"drifted"|"missing"}>>}
 */
export async function rollup({ dataRoot, repoRoot, check = false }) {
  const specs = loadViewSpecs(dataRoot);
  if (specs.length === 0) return [];

  const db = await project(load(dataRoot));
  try {
    return specs.map((spec) => {
      const compiled = compileView(db, spec);
      const outPath = resolveOut(repoRoot, spec.out, spec._file);
      const committed = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

      if (check) {
        const status = committed === null ? "missing" : committed === compiled ? "unchanged" : "drifted";
        return { id: spec.id, out: spec.out, status, compiled, committed };
      }

      if (committed === compiled) return { id: spec.id, out: spec.out, status: "unchanged" };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, compiled, "utf8");
      return { id: spec.id, out: spec.out, status: "written" };
    });
  } finally {
    db.close();
  }
}
