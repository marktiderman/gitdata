/**
 * The `sections` shape — headings, markdown tables, and empty-state placeholders.
 *
 * Answers "list these rows, filtered and sorted, under these headings." A section whose query
 * returns nothing disappears entirely unless it declares `empty:` — a heading over zero rows is
 * drift, and the reference implementations this was proved against are explicit about which
 * sections get a placeholder and which simply vanish.
 */
import { query } from "../project.js";
import { column, ident, orderBy, rowExpr, ShapeError, where } from "./sql.js";

/**
 * @param {object} db
 * @param {{sections: Array}} spec
 * @returns {string[]} rendered lines
 */
export function sections(db, spec) {
  if (!Array.isArray(spec.sections)) throw new ShapeError("sections shape needs a `sections:` list");
  const out = [];

  for (const section of spec.sections) {
    // A section may be pure text (a heading, a blank line) or a table.
    if (section.text !== undefined) {
      out.push(...(Array.isArray(section.text) ? section.text : [section.text]));
      continue;
    }
    if (!section.from) throw new ShapeError("a section needs `from:` or `text:`");

    const cols = (section.columns ?? []).map(column);
    if (cols.length === 0) throw new ShapeError(`section on "${section.from}" needs \`columns:\``);

    const rows = query(
      db,
      `SELECT ${rowExpr(cols)} AS line
         FROM ${ident(section.from)}
        WHERE ${where(section.where)}
        ORDER BY ${orderBy(section.order).join(", ")}`,
    ).map((r) => r.line);

    if (rows.length === 0 && section.empty === undefined) continue; // vanish, heading and all

    if (section.heading) out.push(...(Array.isArray(section.heading) ? section.heading : [section.heading]));
    if (section.header !== false) {
      const names = cols.map((c) => c.as);
      out.push(`| ${names.join(" | ")} |`, `| ${names.map(() => "---").join(" | ")} |`);
    }
    out.push(...(rows.length > 0 ? rows : [section.empty]));
    if (section.after) out.push(...(Array.isArray(section.after) ? section.after : [section.after]));
  }

  return out;
}
