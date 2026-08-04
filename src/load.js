/**
 * Walk a gitdata root and load every table.
 *
 * folder = table · file = row · frontmatter = columns.
 *
 * Non-rows, matching the roller's existing reservation: `_`-prefixed files (`_template.md`),
 * `README.md` (case-insensitively — `ReadMe.md` must not be parsed as a row), anything not
 * `.md`, and `_`-prefixed directories (`_schema/`, `_views/`).
 *
 * A table's rows may be **nested**: `data/sessions/2026/01/x.md` is a row of `sessions`, not of a
 * table called `2026`. Sharding by date is the ordinary way a table outgrows one flat directory,
 * and reading only the top level dropped those rows with no error and no count — the failure mode
 * this project exists to prevent, in the loader itself.
 *
 * Rows are sorted by their path relative to the table so a compile never depends on directory
 * order — that determinism is what makes byte-identical drift checking possible.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";

export class LoadError extends Error {}

/**
 * What counts as a row. Exported because it is a contract, not a detail.
 *
 * A consumer that writes into `data/` has to answer the same question this loader answers, and
 * with nothing to import it answers it by copying these four clauses. The copy is then free to
 * drift, and drift here is not symmetric: a consumer that deletes rows by its own copy of the rule
 * either deletes a file the loader protects, or leaves behind one the loader reads. Both are
 * silent, and both are the failure this project exists to prevent — one repo away.
 *
 * The dot clause is not decoration. The walk skips `.`-prefixed entries, so `.hidden.md` is never
 * loaded as a row — but a predicate without this clause calls it one. That gap is invisible while
 * the rule lives inside the loader and the walk filters first; the moment it is handed out, a
 * consumer asking "is this a row?" gets an answer the loader would not give. Exporting a predicate
 * that disagrees with the loader would recreate, inside this file, the drift exporting it prevents.
 */
export const isRowFile = (name) =>
  name.endsWith(".md") &&
  !name.startsWith("_") &&
  !name.startsWith(".") &&
  name.toLowerCase() !== "readme.md";

/**
 * Classify an entry by what it points AT, not what it is: a Dirent for a symlink reports neither
 * file nor directory, which silently dropped every row behind a symlinked shard — the exact
 * failure mode this loader's docstring vows to prevent. `statSync` follows links; a dangling one
 * fails loud with the path instead of a raw ENOENT.
 */
function statOf(dir, name, rel) {
  try {
    return statSync(join(dir, name));
  } catch (cause) {
    throw new LoadError(`${rel}: unreadable entry (dangling symlink?) — ${cause.message}`);
  }
}

/** Row-file paths under `dir`, relative to it, depth-first and sorted. */
function rowPaths(dir, prefix = "", seen = new Set([realpathSync(dir)])) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = statOf(dir, entry.name, rel);
    if (stat.isDirectory()) {
      // A symlink pointing at an ancestor would otherwise recurse until the stack overflows.
      const real = realpathSync(join(dir, entry.name));
      if (seen.has(real)) continue;
      out.push(...rowPaths(join(dir, entry.name), rel, new Set([...seen, real])));
    } else if (isRowFile(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Every row file under a table directory, relative to it, in load order — shards included.
 *
 * `isRowFile` alone is only half the contract. The other half is that a table may nest, so a
 * consumer holding the predicate still reaches for `readdirSync` and gets a flat list: on a
 * sharded table it finds none of the rows the loader loads, and any wholesale rewrite built on it
 * leaves the shards behind while reporting the table replaced. Handing out the same walk removes
 * the second place that has to be got right.
 *
 * @returns {string[]}
 */
export function rowFilesIn(dir) {
  return rowPaths(dir);
}

/**
 * The rows of `dir` that do not physically live under it — the subset a DESTRUCTIVE consumer has
 * to decide about.
 *
 * Following a symlinked shard is deliberate: a Dirent for a symlink reports neither file nor
 * directory, and honouring that dropped every row behind one. So `rowFilesIn` returns them, and
 * must, or it would stop answering the same question the loader answers.
 *
 * Reading them is safe. DELETING them is not necessarily: a consumer rewriting a machine-owned
 * table wholesale removes every path `rowFilesIn` reports, and through a link that reaches outside
 * the table — at worst outside the repo. The two callers want opposite things from the same list,
 * so the list stays honest and the fact is published beside it.
 *
 * Policy is deliberately NOT decided here. gitdata owns the mechanics; the consumer owns the
 * naming, and the ruling. A rewriter can refuse the table, skip these paths, or delete them
 * knowingly — but it can no longer do so unknowingly, which is the only outcome this rules out.
 * Silently filtering them from `rowFilesIn` would be worse than either: rows the loader reads
 * would vanish from the list that claims to enumerate them, which is precisely the asymmetry
 * exporting this contract exists to end.
 *
 * An unresolvable path counts as escaping. A consumer's safe move on "I cannot tell" is the same
 * as on "it is outside": do not delete it.
 *
 * @returns {string[]} paths relative to `dir`, a subset of `rowFilesIn(dir)`; empty in the
 *   ordinary case where a table is a plain directory.
 */
export function escapedRowFiles(dir) {
  const root = realpathSync(dir);
  const inside = root.endsWith(sep) ? root : root + sep;
  return rowPaths(dir).filter((rel) => {
    let real;
    try {
      real = realpathSync(join(dir, rel));
    } catch {
      return true;
    }
    return !real.startsWith(inside);
  });
}

/** @returns {Map<string, {name: string, rows: Array<{_file: string, _body: string}>}>} */
export function load(root) {
  const tables = new Map();

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    if (!statOf(root, entry.name, entry.name).isDirectory()) continue;
    const dir = join(root, entry.name);

    const rows = [];
    for (const file of rowPaths(dir)) {
      const path = join(dir, file);
      const { data, body } = parseFrontmatter(readFileSync(path, "utf8"), {
        file: `${entry.name}/${file}`,
      });
      // `_file` carries the path relative to the table, so two shards may hold same-named files
      // and a row still says where it came from.
      rows.push({ ...data, _file: file, _body: body });
    }
    tables.set(entry.name, { name: entry.name, rows });
  }

  return tables;
}
