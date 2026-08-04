/**
 * The rollup: read views, run their queries, render, write — or check for drift.
 *
 * `rollup()` regenerates every view. `rollup({ check: true })` compiles in memory and compares
 * against what is committed without writing, which is the driftproof guarantee: a hand-edited
 * artifact, or a source edit without a regenerate, fails the check.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { load } from "./load.js";
import { project, query } from "./project.js";
import { renderTemplate } from "./render.js";
import { runShape } from "./shapes/index.js";

export class ViewSpecError extends Error {}

/**
 * The real filesystem location a path lands at: realpath of its nearest existing ancestor with
 * the not-yet-existing remainder re-appended. A purely lexical check is defeated by a symlink
 * anywhere in the path — `data/_views → /elsewhere` passes `relative()` yet writes outside.
 */
function realTarget(path) {
  let existing = path;
  const tail = [];
  while (!existsSync(existing)) {
    tail.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...tail);
}

/**
 * Resolve a path a spec names and refuse to leave the repo.
 *
 * `out: ../../x.md` otherwise writes wherever the process can reach — a typo silently drops a
 * file outside the project, and an installed third-party pack could target `~/.bashrc`. The
 * check runs on real paths, so a symlinked directory inside the repo cannot smuggle the write
 * out either. A rollup only ever touches files belonging to the repo it was pointed at.
 */
function resolveWithin(repoRoot, path, specFile, field) {
  const base = realpathSync(resolve(repoRoot));
  const target = realTarget(resolve(base, path));
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ViewSpecError(`${specFile}: "${field}" escapes the repo root — ${path}`);
  }
  return target;
}

/** Read `<root>/_views/*.view.yml`, sorted by filename for deterministic reporting. */
export function loadViewSpecs(dataRoot) {
  const dir = join(dataRoot, "_views");
  if (!existsSync(dir)) return [];

  const specs = readdirSync(dir)
    .filter((f) => f.endsWith(".view.yml"))
    .sort()
    .map((file) => {
      const spec = parseYaml(readFileSync(join(dir, file), "utf8"));
      for (const field of ["id", "out"]) {
        if (!spec?.[field]) throw new ViewSpecError(`${file}: missing required field "${field}"`);
        if (typeof spec[field] !== "string") {
          throw new ViewSpecError(`${file}: "${field}" must be a string, got ${typeof spec[field]}`);
        }
      }
      if (spec.compile) {
        if (typeof spec.compile !== "string") {
          throw new ViewSpecError(`${file}: "compile" must be a module path string, got ${typeof spec.compile}`);
        }
        if (spec.queries || spec.template) {
          throw new ViewSpecError(`${file}: "compile" replaces "queries"/"template" — declare one or the other`);
        }
      } else {
        for (const field of ["queries", "template"]) {
          if (!spec?.[field]) throw new ViewSpecError(`${file}: missing required field "${field}"`);
        }
      }
      return { ...spec, _file: file };
    });

  // Two specs sharing an id or an out would silently overwrite each other and leave `--check`
  // failing forever: the artifact on disk always holds the later spec's bytes, so the earlier
  // spec reports drift no matter how many times the user reruns rollup as told.
  const byId = new Map();
  const byOut = new Map();
  for (const spec of specs) {
    if (byId.has(spec.id)) {
      throw new ViewSpecError(`duplicate view id "${spec.id}" — declared by both ${byId.get(spec.id)} and ${spec._file}`);
    }
    byId.set(spec.id, spec._file);
    const outKey = normalize(spec.out);
    if (byOut.has(outKey)) {
      throw new ViewSpecError(`duplicate view out "${spec.out}" — written by both ${byOut.get(outKey)} and ${spec._file}`);
    }
    byOut.set(outKey, spec._file);
  }

  return specs;
}

/**
 * Compile one view to its final text without touching disk.
 *
 * A `queries:` entry is either raw SQL (a string) or a shape declaration (a mapping with
 * `shape:`). Both yield rows whose first column is a line, so the renderer cannot tell them
 * apart and a view may mix the two.
 *
 * A spec with `compile:` instead names a JS module (path relative to `data/_views/`) whose
 * default export receives `(db, { query, runShape })` and returns the artifact text — the escape
 * hatch for anything the template cannot express, so the template syntax never grows.
 */
/**
 * Every table name a shape spec names via `from:`, at any nesting depth — `digest`'s blocks and
 * counts, `sections`'s section list, and `tree`'s top-level `from:` all use the same key, just at
 * different depths. Structural, not semantic: this walks the shape's own declared vocabulary
 * (every shape requires `from:` to name its table), it does not know what any table means.
 */
function shapeTables(spec) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "from" && typeof value === "string") found.add(value);
        else walk(value);
      }
    }
  };
  walk(spec);
  return found;
}

export async function compileView(db, spec, { emptyTables = new Set() } = {}) {
  if (spec.compile) {
    if (!spec._compilePath) {
      throw new ViewSpecError(`${spec._file ?? spec.id}: "compile" spec must be resolved by rollup() (missing _compilePath)`);
    }
    const mod = await import(pathToFileURL(spec._compilePath).href);
    if (typeof mod.default !== "function") {
      throw new ViewSpecError(`${spec._file}: compile module has no default function export — ${spec.compile}`);
    }
    const text = await mod.default(db, { query, runShape });
    if (typeof text !== "string") {
      throw new ViewSpecError(`${spec._file}: compile module must return a string, got ${typeof text}`);
    }
    return text;
  }

  const results = {};
  for (const [name, q] of Object.entries(spec.queries)) {
    try {
      results[name] = typeof q === "string" ? query(db, q) : runShape(db, q);
    } catch (cause) {
      // The literal first-run state (issue #4): a table with zero rows has zero discovered
      // columns beyond `_file`/`_body`, so any query naming a frontmatter column fails with a
      // raw SQLite parser error that points at the SQL, not the actual cause. A shape query
      // names its table structurally (`from:`), so when that table is empty this is not a guess
      // — say so and name the fix, instead of forwarding "no such column" to a stranger.
      //
      // Gated on the underlying error actually being a missing-column/table failure, not just on
      // the table being empty: a malformed shape spec (ShapeError, thrown before any SQL runs —
      // "needs `line:`", "needs `blocks:` list") can equally reference an empty table, and that
      // real cause must not be swallowed by a misleading "add a row" message.
      const looksLikeMissingColumnOrTable = /no such (column|table)/i.test(cause.message);
      const empty = looksLikeMissingColumnOrTable && q && typeof q === "object"
        ? [...shapeTables(q)].find((t) => emptyTables.has(t))
        : null;
      const message = empty
        ? `${spec._file ?? spec.id}: "${empty}" has no rows yet — add a row under data/${empty}/ (copy its _template.md if it has one), then re-run`
        : `${spec._file ?? spec.id}: query "${name}" failed — ${cause.message}`;
      throw new ViewSpecError(message, { cause });
    }
  }
  return renderTemplate(spec.template, results);
}

/**
 * Line-based diff between two texts, via a classic O(n·m) LCS. `--check` already computes both
 * sides of the comparison (see `rollup()` below) — this is what turns that pair into something a
 * human or a machine can read instead of the boolean the drift check used to report and discard.
 *
 * Dependency-free by design: no diff library is a project dependency, and adding one for this is
 * unjustified when a direct implementation handles the file sizes rollup renders (rendered docs,
 * not arbitrary blobs). `null` (the "missing" status's committed side) is treated as an empty
 * file, so a missing artifact's diff reads as every line added.
 *
 * Deterministic by construction (law 4): the same two strings always produce the same entries —
 * nothing here depends on iteration order, time, or randomness.
 *
 * @returns {Array<{type: "context"|"add"|"remove", line: string}>}
 */
export function diffLines(oldText, newText) {
  const aAll = oldText == null ? [] : oldText.split("\n");
  const bAll = newText == null ? [] : newText.split("\n");

  // The LCS table below costs 4*(n+1)*(m+1) bytes — two 20,000-line sides would be over a
  // gigabyte. Identical head and tail lines need no LCS at all, so trim them first; real drift
  // touches few lines, so this shrinks the table to the actual changed window. Deterministic —
  // the trim depends only on the two inputs, not on iteration order.
  let head = 0;
  while (head < aAll.length && head < bAll.length && aAll[head] === bAll[head]) head++;
  let tail = 0;
  while (
    tail < aAll.length - head &&
    tail < bAll.length - head &&
    aAll[aAll.length - 1 - tail] === bAll[bAll.length - 1 - tail]
  ) {
    tail++;
  }

  const a = aAll.slice(head, aAll.length - tail);
  const b = bAll.slice(head, bAll.length - tail);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i:] and b[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const entries = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      entries.push({ type: "context", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      entries.push({ type: "remove", line: a[i] });
      i++;
    } else {
      entries.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) entries.push({ type: "remove", line: a[i++] });
  while (j < m) entries.push({ type: "add", line: b[j++] });

  return [
    ...aAll.slice(0, head).map((line) => ({ type: "context", line })),
    ...entries,
    ...aAll.slice(aAll.length - tail).map((line) => ({ type: "context", line })),
  ];
}

/** Render `diffLines()` output as unified-diff-style text: ` ` context, `-` removed, `+` added. */
export function formatDiff(entries) {
  const prefix = { context: " ", add: "+", remove: "-" };
  return entries.map((e) => `${prefix[e.type]}${e.line}`).join("\n");
}

/**
 * @param {{dataRoot: string, repoRoot: string, check?: boolean}} opts
 * @returns {Promise<Array<{id: string, out: string, status: "written"|"unchanged"|"drifted"|"missing"}>>}
 */
export async function rollup({ dataRoot, repoRoot, check = false }) {
  const specs = loadViewSpecs(dataRoot);
  if (specs.length === 0) return [];

  const tables = load(dataRoot);
  const emptyTables = new Set([...tables.values()].filter((t) => t.rows.length === 0).map((t) => t.name));

  const db = await project(tables);
  try {
    const results = [];
    for (const spec of specs) {
      if (spec.compile) {
        // Resolved against the spec's own directory, contained like `out:` — a view must not
        // execute code from outside the repo it belongs to.
        spec._compilePath = resolveWithin(repoRoot, resolve(dataRoot, "_views", spec.compile), spec._file, "compile");
      }
      const compiled = await compileView(db, spec, { emptyTables });
      const outPath = resolveWithin(repoRoot, spec.out, spec._file, "out");
      const committed = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

      if (check) {
        const status = committed === null ? "missing" : committed === compiled ? "unchanged" : "drifted";
        results.push({ id: spec.id, out: spec.out, status, compiled, committed });
        continue;
      }

      if (committed === compiled) {
        results.push({ id: spec.id, out: spec.out, status: "unchanged" });
        continue;
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, compiled, "utf8");
      results.push({ id: spec.id, out: spec.out, status: "written" });
    }
    return results;
  } finally {
    db.close();
  }
}
