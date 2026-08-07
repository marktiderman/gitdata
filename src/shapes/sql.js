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
 * A comparison VALUE → a SQL literal of the right type.
 *
 * Distinct from `lit()`, which is the string-literal primitive and stays that way: it is also how
 * section names, `map` keys/values and `wrap` fragments reach the SQL, where quoting is always
 * correct. A value being COMPARED to a column is the one place where the type has to survive.
 *
 * It has to survive because the projection declares no column types — `CREATE TABLE t ("v")` —
 * so every column has BLOB (no) affinity and SQLite converts nothing on either side of a
 * comparison. A frontmatter `contract_version: 1` is stored as INTEGER, and `1 = '1'` is FALSE
 * while `1 IS NOT '1'` is TRUE. Quoting a numeric filter value therefore did not merely narrow a
 * result — it inverted it, silently, with no error and no empty-result hint to notice.
 *
 * Booleans emit 1/0 to match `toSqlValue`'s flattening in project.js. Everything else — strings,
 * null, dates, anything exotic — keeps the previous behaviour and goes through `lit()`; a
 * non-finite number has no SQL spelling, so it does too.
 */
export const sqlValue = (v) => {
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return lit(v);
};

/**
 * A `where:` block → a SQL predicate.
 *
 *   { status: shipped }                  → "status" = 'shipped'
 *   { status: { in: [a, b] } }           → "status" IN ('a','b')
 *   { status: { not: shipped } }         → "status" IS NOT 'shipped'
 *   { version: { not: 1 } }              → "version" IS NOT 1
 *   { parent: null }                     → ("parent" IS NULL OR "parent" IN ('null','None',''))
 *
 * `null` deliberately also matches the STRINGS "null"/"None"/"" — frontmatter written by hand and
 * by three different tools disagrees about how to spell empty, and a rollup that silently drops
 * those rows is worse than one that accepts all four spellings.
 *
 * Values go through `sqlValue`, not `lit`, so a numeric or boolean filter compares as its own
 * type against the untyped column the projection built. `not:` stays `IS NOT` rather than `!=`
 * for the same reason `null` accepts four spellings: `NULL != 1` is NULL, so `!=` would drop
 * every row that simply lacks the key, which is the opposite of what "not 1" means to a consumer.
 */
/**
 * "This cell holds nothing" — the one definition of empty, in one place.
 *
 * Frontmatter written by hand and by three different tools disagrees about how to spell empty, so
 * an absent key, a YAML `null`, and the STRINGS "null"/"None"/"" all mean the same thing. This
 * used to be spelled inline in exactly one branch of `where()`, which is why the other three
 * branches each disagreed with it in a different way.
 */
const isEmpty = (col) => `(${col} IS NULL OR ${col} IN ('null','None',''))`;

/** Does an `in:`/`not_in:` list ask about empty? Only a real null does; the string "null" is a value. */
const listHasNull = (list) => list.some((v) => v === null || v === undefined);
const withoutNull = (list) => list.filter((v) => v !== null && v !== undefined);

export function where(clause) {
  if (!clause) return "1=1";
  const parts = Object.entries(clause).map(([field, test]) => {
    const col = ident(field);
    if (test === null) return isEmpty(col);
    if (typeof test !== "object") return `${col} = ${sqlValue(test)}`;

    if (Array.isArray(test.in)) {
      const vals = withoutNull(test.in);
      const inList = vals.length ? `${col} IN (${vals.map((v) => sqlValue(v)).join(", ")})` : null;
      if (!listHasNull(test.in)) return inList ?? "1=0"; // `in: []` matches nothing, and says so
      return inList ? `(${inList} OR ${isEmpty(col)})` : isEmpty(col);
    }

    if (Array.isArray(test.not_in)) {
      const vals = withoutNull(test.not_in);
      // `NOT IN` is three-valued: a NULL column yields NULL, which is not TRUE, so the row is
      // dropped. `not:` deliberately avoids that with `IS NOT`; this branch has to say the same
      // thing out loud or the two disagree about a row that simply lacks the key.
      const notIn = vals.length ? `(${col} NOT IN (${vals.map((v) => sqlValue(v)).join(", ")}) OR ${col} IS NULL)` : null;
      if (!listHasNull(test.not_in)) return notIn ?? "1=1"; // `not_in: []` excludes nothing
      // An explicit null in the list means "and not the empty ones either", so the null-safety
      // above is exactly what must NOT apply — the caller asked for empties to be excluded.
      return notIn ? `(${notIn} AND NOT ${isEmpty(col)})` : `NOT ${isEmpty(col)}`;
    }

    if ("not" in test) {
      // The complement of `field: null` must be the complement, not `IS NOT 'null'` — which
      // matches three of the four spellings of empty and so returns rows that ARE empty.
      if (test.not === null) return `NOT ${isEmpty(col)}`;
      return `${col} IS NOT ${sqlValue(test.not)}`;
    }
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
 * checkout. It defaults to `_file` — the one column the engine itself guarantees on every table,
 * unique per row — because defaulting to `id` baked a consumer column name into the engine and
 * crashed any table without one.
 */
export function orderBy(order, { defaultTieBreak = "_file" } = {}) {
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
