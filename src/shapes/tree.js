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
import { column, ident, isEmptyValue, orderBy, ShapeError, where } from "./sql.js";

/**
 * A root is a row whose parent is empty — and "empty" means exactly what it means everywhere else.
 *
 * This used to be a private copy of the four spellings with a comment promising it "mirrors the
 * null semantics of `where:`". A promise to stay in step is not a mechanism for staying in step;
 * the copies were correct only until somebody edited one. Now it IS the same definition, so
 * `where: {parent: null}` and tree's root detection cannot disagree.
 */
const isRoot = isEmptyValue;

/**
 * @param {object} db
 * @param {{from: string, id?: string, parent?: string, line: Array, indent?: string,
 *          where?: object, order?: object|string,
 *          orphans?: {heading?: string|string[], bare?: boolean}}} spec
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
  //
  // Duplicate ids are refused rather than tolerated. `project.js` creates tables with no PRIMARY
  // KEY and frontmatter enforces nothing, so two rows can share an id — and the walk would emit
  // the first, skip the second as already-seen, and then exclude it from the orphan sweep for the
  // same reason. The row would vanish with no output at all, breaking this shape's one promise:
  // every row appears exactly once, in the tree or under orphans.
  const children = new Map();
  const known = new Set();
  for (const r of rows) {
    const id = String(r._id);
    if (known.has(id)) {
      throw new ShapeError(
        `tree on "${spec.from}": duplicate ${idCol} "${id}" — ids must be unique to place a row`,
      );
    }
    known.add(id);
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
