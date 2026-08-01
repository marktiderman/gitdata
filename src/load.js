/**
 * Walk a gitdata root and load every table.
 *
 * folder = table · file = row · frontmatter = columns.
 *
 * Non-rows, matching the roller's existing reservation: `_`-prefixed files (`_template.md`),
 * `README.md` (case-insensitively — `ReadMe.md` must not be parsed as a row), anything not
 * `.md`, and `_`-prefixed directories (`_schema/`, `_views/`).
 *
 * Rows are sorted by filename so a compile never depends on directory order — that determinism
 * is what makes byte-identical drift checking possible.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";

const isRowFile = (name) =>
  name.endsWith(".md") && !name.startsWith("_") && name.toLowerCase() !== "readme.md";

/** @returns {Map<string, {name: string, rows: Array<{_file: string, _body: string}>}>} */
export function load(root) {
  const tables = new Map();

  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;

    const rows = [];
    for (const file of readdirSync(dir).sort()) {
      if (!isRowFile(file)) continue;
      const path = join(dir, file);
      const { data, body } = parseFrontmatter(readFileSync(path, "utf8"), { file: `${entry}/${file}` });
      rows.push({ ...data, _file: file, _body: body });
    }
    tables.set(entry, { name: entry, rows });
  }

  return tables;
}
