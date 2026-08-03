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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";

const isRowFile = (name) =>
  name.endsWith(".md") && !name.startsWith("_") && name.toLowerCase() !== "readme.md";

/** Row-file paths under `dir`, relative to it, depth-first and sorted. */
function rowPaths(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...rowPaths(join(dir, entry.name), rel));
    else if (isRowFile(entry.name)) out.push(rel);
  }
  return out.sort();
}

/** @returns {Map<string, {name: string, rows: Array<{_file: string, _body: string}>}>} */
export function load(root) {
  const tables = new Map();

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
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
