/**
 * Shared SQL construction for shapes.
 *
 * Consumers never write SQL — they declare what their data means, and these helpers turn that
 * into expressions. Everything here is domain-agnostic: it knows what a filter and a column are,
 * never what a "feature" is.
 */

export class ShapeError extends Error {}

/** SQL string literal. Single quotes doubled — the only escaping SQLite needs. */
export const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
/** SQL identifier. */
export const ident = (v) => `"${String(v).replace(/"/g, '""')}"`;

/**
 * A `where:` block → a SQL predicate.
 *
 *   { status: shipped }                  → "status" = 'shipped'
 *   { status: { in: [a, b] } }           → "status" IN ('a','b')
 *   { status: { not: shipped } }         → "status" IS NOT 'shipped'
 *   { parent: null }                     → ("parent" IS NULL OR "parent" IN ('null','None',''))
 *
 * `null` deliberately also matches the STRINGS "null"/"None"/"" — frontmatter written by hand and
 * by three different tools disagrees about how to spell empty, and a rollup that silently drops
 * those rows is worse than one that accepts all four spellings.
 */
export function where(clause) {
  if (!clause) return "1=1";
  const parts = Object.entries(clause).map(([field, test]) => {
    const col = ident(field);
    if (test === null) return `(${col} IS NULL OR ${col} IN ('null','None',''))`;
    if (typeof test !== "object") return `${col} = ${lit(test)}`;
    if (Array.isArray(test.in)) return `${col} IN (${test.in.map(lit).join(", ")})`;
    if (Array.isArray(test.not_in)) return `${col} NOT IN (${test.not_in.map(lit).join(", ")})`;
    if ("not" in test) return `${col} IS NOT ${lit(test.not)}`;
    throw new ShapeError(`unsupported filter on "${field}": ${JSON.stringify(test)}`);
  });
  return parts.length ? parts.join(" AND ") : "1=1";
}

/**
 * A column spec → a SQL expression producing its display text.
 *
 *   "id"                                          → "id"
 *   { from: coord, wrap: "`{}`" }                 → '`' || "coord" || '`'
 *   { from: state, map: {done: shipped, "*": open} } → CASE WHEN ... END
 *   { from: body, section: "The job", truncate: 160 } → md_section("_body", 'The job') truncated
 *   { from: statement, collapse: true }           → collapse_ws("statement")
 *
 * `from: body` is spelled without the underscore because `_body` is an engine detail; a consumer
 * says "the body".
 */
export function column(spec) {
  if (typeof spec === "string") return { expr: ident(spec), as: spec };

  const { from, as, wrap, map, section, truncate, collapse, sanitize } = spec;
  if (!from) throw new ShapeError(`column spec needs "from": ${JSON.stringify(spec)}`);

  let expr = from === "body" ? ident("_body") : ident(from);
  if (section) expr = `md_section(${expr}, ${lit(section)})`;
  if (collapse) expr = `collapse_ws(${expr})`;
  if (truncate) expr = `substr(${expr}, 1, ${Number(truncate)})`;
  // A markdown table cell cannot contain a bare pipe; the reference implementations replace it.
  if (sanitize !== false) expr = `replace(${expr}, '|', '/')`;

  if (map) {
    const fallback = "*" in map ? lit(map["*"]) : `COALESCE(${expr}, '')`;
    const cases = Object.entries(map)
      .filter(([k]) => k !== "*")
      .map(([k, v]) => `WHEN ${ident(from)} = ${lit(k)} THEN ${lit(v)}`)
      .join(" ");
    expr = `CASE ${cases} ELSE ${fallback} END`;
  }

  expr = `COALESCE(${expr}, '')`;
  if (wrap) {
    const [before, after] = String(wrap).split("{}");
    expr = `${lit(before ?? "")} || ${expr} || ${lit(after ?? "")}`;
  }
  return { expr, as: as ?? from };
}

/**
 * An `order:` block → an ORDER BY expression list.
 *
 *   { by: coord, mode: natural, tie_break: id }
 *
 * `tie_break` is not optional in spirit: rows sharing a sort value would otherwise come back in
 * whatever order the database chose, and a drift check would fail at random on a different
 * checkout. It defaults to `id` for exactly that reason.
 */
export function orderBy(order, { defaultTieBreak = "id" } = {}) {
  if (!order) return [ident(defaultTieBreak)];
  const spec = typeof order === "string" ? { by: order } : order;
  const keys = Array.isArray(spec.by) ? spec.by : [spec.by];

  const exprs = keys.map((k) => (spec.mode === "natural" ? `natural_key(${ident(k)})` : ident(k)));
  const tie = spec.tie_break === null ? null : ident(spec.tie_break ?? defaultTieBreak);
  if (tie && !keys.includes(spec.tie_break ?? defaultTieBreak)) exprs.push(tie);
  return exprs;
}

/** Join column expressions into one markdown table row: `| a | b | c |`. */
export const rowExpr = (cols) =>
  `'| ' || ${cols.map((c) => c.expr).join(" || ' | ' || ")} || ' |'`;
