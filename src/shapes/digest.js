/**
 * The `digest` shape — formatted lines, block by block, with conditional blocks and counts.
 *
 * Answers "render these rows as lines, and put literal text between them." Distinct from
 * `sections` because the output is prose-shaped rather than tabular, and because a block can be
 * conditional on another block having content — a heading that survives its own empty list is
 * drift, which is exactly the defect this shape's reference implementation avoids with `if live`.
 */
import { query } from "../project.js";
import { column, ident, orderBy, ShapeError, where } from "./sql.js";

/** Count matching rows — used both for `{placeholders}` and for `when: has_rows`. */
function count(db, block) {
  return query(db, `SELECT COUNT(*) AS n FROM ${ident(block.from)} WHERE ${where(block.where)}`)[0].n;
}

/**
 * Substitute `{name}` from a bag of named counts. Deliberately not a template language: a digest
 * line interpolates numbers the consumer has already declared, nothing more.
 */
function fill(text, counts) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in counts)) throw new ShapeError(`digest line references unknown count "${name}"`);
    return String(counts[name]);
  });
}

/**
 * @param {object} db
 * @param {{counts?: object, blocks: Array}} spec
 * @returns {string[]} rendered lines
 */
export function digest(db, spec) {
  if (!Array.isArray(spec.blocks)) throw new ShapeError("digest shape needs a `blocks:` list");

  const counts = Object.fromEntries(
    Object.entries(spec.counts ?? {}).map(([name, c]) => [name, count(db, c)]),
  );

  const out = [];
  for (const block of spec.blocks) {
    // `when: { has_rows: <countName> }` — the guard that makes a whole block vanish together.
    if (block.when?.has_rows !== undefined && !counts[block.when.has_rows]) continue;

    if (block.text !== undefined) {
      const lines = Array.isArray(block.text) ? block.text : [block.text];
      out.push(...lines.map((l) => fill(l, counts)));
      continue;
    }

    if (!block.from) throw new ShapeError("a digest block needs `from:` or `text:`");
    if (!block.line) throw new ShapeError(`digest block on "${block.from}" needs \`line:\``);

    // `line:` is a template of column specs joined with literals, e.g.
    //   line: ["  ", {from: id}, ": ", {from: statement, collapse: true}]
    const expr = block.line
      .map((part) => (typeof part === "string" ? `'${part.replace(/'/g, "''")}'` : column(part).expr))
      .join(" || ");

    out.push(
      ...query(
        db,
        `SELECT ${expr} AS line FROM ${ident(block.from)}
          WHERE ${where(block.where)} ORDER BY ${orderBy(block.order).join(", ")}`,
      ).map((r) => r.line),
    );
  }

  return out;
}
