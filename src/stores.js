/**
 * `gitdata stores` — the master table of contents for a repo that holds more than one store.
 *
 * A **store** is a directory containing a `data/` trellis. Every other verb is single-store:
 * `--root <dir>` names one, `tables` describes one. A repo with three of them has no way to see
 * them together, and what cannot be enumerated cannot be audited.
 *
 * ONE CONFIG FILE, NOT TWO. A store manifest and a policy file would both answer "what does
 * gitdata know about this store", and both would carry `engine:`. Two documents that overlap is
 * the defect where nobody can tell which one wins, so there is one: `data/_gitdata.yml`, read by
 * `src/doctor.js`. It sits INSIDE `data/`, a namespace gitdata already owns and the loader
 * already ignores (`_`-prefixed), rather than at the store root where it would compete with the
 * consumer's own files for a reserved name.
 *
 * Discovery does not require that file, on purpose. A store that has never adopted a manifest is
 * still a store, and a tool that could only list the repos that had already configured it would
 * be useless for the audit it exists to serve. The manifest is reported as present or absent, and
 * anything only the manifest can say (a table's `class:`) reads UNKNOWN without it.
 *
 * Reads only. Writes nothing.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { load } from "./load.js";
import { readPolicy, POLICY_FILE } from "./doctor.js";

/** Directories a walk must never descend into: not source, and enormous. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor"]);

/** How deep below the root a store may sit. Deep enough for `apps/<x>/`, shallow enough to be cheap. */
const MAX_DEPTH = 4;

/**
 * Is `<dir>/data` a trellis? A manifest, a views directory, a schema directory, or at least one
 * table folder — the same things `load()` and `rollup()` would find something in. An empty `data/`
 * is not a store; it is an empty directory that happens to share a name.
 */
function trellisAt(dir) {
  const data = join(dir, "data");
  if (!existsSync(data)) return null;
  let entries;
  try {
    if (!statSync(data).isDirectory()) return null;
    entries = readdirSync(data, { withFileTypes: true });
  } catch {
    return null;
  }
  const manifest = entries.some((e) => e.name === POLICY_FILE);
  const marked = entries.some((e) => e.name === "_views" || e.name === "_schema");
  const tables = entries.some((e) => !e.name.startsWith("_") && !e.name.startsWith(".") && statSync(join(data, e.name)).isDirectory());
  return manifest || marked || tables ? { data, manifest } : null;
}

/**
 * Every store at or below `root`, nearest first then alphabetical — deterministic, like every
 * other listing this project emits.
 *
 * @returns {Array<{root: string, data: string, manifest: boolean}>} absolute paths
 */
export function findStores(root, { maxDepth = MAX_DEPTH } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    const trellis = trellisAt(dir);
    if (trellis) found.push({ root: dir, data: trellis.data, manifest: trellis.manifest });
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      // Never descend into a store's own trellis: `data/<table>/` is rows, not another store.
      if (trellis && entry.name === "data") continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The table of contents: each store, its tables, their row counts, and each table's declared
 * `class` where the store's manifest declares one.
 *
 * `class` is `null` — printed as UNKNOWN, never blanked — for a table no manifest classifies. A
 * table the manifest names that has no directory is reported too, with a null row count, because
 * a declaration pointing at nothing is exactly the drift this tool exists to surface.
 *
 * @returns {Array<{root: string, data: string, manifest: boolean, engine: string|null,
 *                  tables: Array<{name: string, rows: number|null, class: string|null, written_by: string|null}>}>}
 */
export function describeStores(root) {
  return findStores(root).map((store) => {
    const policy = readPolicy(store.data);
    const declared = policy.tables ?? {};

    let loaded;
    try {
      loaded = load(store.data);
    } catch {
      loaded = new Map();
    }

    const names = [...new Set([...loaded.keys(), ...Object.keys(declared)])].sort();
    const tables = names.map((name) => ({
      name,
      rows: loaded.has(name) ? loaded.get(name).rows.length : null,
      class: declared[name]?.class ?? null,
      written_by: declared[name]?.written_by ?? null,
    }));

    return {
      root: relative(root, store.root) || ".",
      data: relative(root, store.data),
      manifest: store.manifest,
      engine: policy.engine,
      tables,
    };
  });
}
