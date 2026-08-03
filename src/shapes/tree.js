/**
 * The `tree` shape — walk a parent→child hierarchy, indented, with orphans.
 *
 * Answers "show these rows as a nesting, and tell me what could not be placed."
 *
 * The walk happens in JavaScript rather than as a recursive CTE on purpose. A generic
 * `WITH RECURSIVE` over consumer-named id/parent columns is buildable but unreadable, and it
 * still cannot answer the question that matters — *which rows never got placed* — without a
 * second anti-join. Ordering stays in SQL, where `ORDER BY` already makes sibling order
 * deterministic; only the nesting is done here.
 *
 * Unplaceable rows are never dropped. A row is an orphan when the walk from the roots does not
 * reach it, which covers both causes at once: a `parent` naming a row that does not exist, and a
 * cycle (`a → b → a`), whose members have resolvable parents yet no path to any root. Classifying
 * on reachability rather than on "does the parent resolve" is what keeps a cycle from vanishing
 * silently — the failure mode a hierarchy view exists to expose.
 */
import { query } from "../project.js";
import { column, ident, orderBy, ShapeError, where } from "./sql.js";

/**
 * Frontmatter written by hand and by three different tools disagrees about how to spell empty.
 * Mirrors the null semantics of `where:` in sql.js so a root is a root either way.
 */
const isRoot = (v) => v == null || v === "null" || v === "None" || v === "";

/**
 * @param {object} db
 * @param {{from: string, id?: string, parent?: string, line: Array, indent?: string,
 *          where?: object, order?: object|string, orphans?: {heading?: string|string[], empty?: string}}} spec
 * @returns {string[]} rendered lines
 */
export function tree(db, spec) {
  if (!spec.from) throw new ShapeError("tree shape needs `from:`");
  if (!Array.isArray(spec.line)) throw new ShapeError(`tree on "${spec.from}" needs \`line:\``);

  const idCol = spec.id ?? "id";
  const parentCol = spec.parent ?? "parent";
  const indent = spec.indent ?? "  ";

  // `line:` is the digest convention — literals interleaved with column specs.
  const lineExpr = spec.line
    .map((part) => (typeof part === "string" ? `'${part.replace(/'/g, "''")}'` : column(part).expr))
    .join(" || ");

  const rows = query(
    db,
    `SELECT ${ident(idCol)} AS _id, ${ident(parentCol)} AS _parent, ${lineExpr} AS line
       FROM ${ident(spec.from)}
      WHERE ${where(spec.where)}
      ORDER BY ${orderBy(spec.order, { defaultTieBreak: idCol }).join(", ")}`,
  );

  // Children keyed by parent id, each list already in the query's deterministic order.
  const children = new Map();
  const known = new Set();
  for (const r of rows) {
    known.add(String(r._id));
    if (isRoot(r._parent)) continue;
    const key = String(r._parent);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(r);
  }

  const out = [];
  const seen = new Set();

  const walk = (row, depth) => {
    const id = String(row._id);
    if (seen.has(id)) return; // a row reachable by two paths is emitted once, at its first
    seen.add(id);
    out.push(`${indent.repeat(depth)}${row.line}`);
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };

  for (const row of rows) if (isRoot(row._parent)) walk(row, 0);

  const orphans = rows.filter((r) => !seen.has(String(r._id)));
  if (orphans.length === 0) return out;

  // A heading over zero rows is drift, so the block only appears when something failed to place.
  const spec_ = spec.orphans ?? {};
  if (spec_.heading) out.push(...(Array.isArray(spec_.heading) ? spec_.heading : [spec_.heading]));
  for (const o of orphans) {
    const why = known.has(String(o._parent)) ? "unreachable (cycle)" : `parent "${o._parent}" not found`;
    out.push(spec_.bare ? o.line : `${o.line}  <!-- ${why} -->`);
  }
  return out;
}
