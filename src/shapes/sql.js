/**
 * Shared SQL construction for shapes.
 *
 * Consumers never write SQL — they declare what their data means, and these helpers turn that
 * into expressions. Everything here is domain-agnostic: it knows what a filter and a column are,
 * never what a "feature" is.
 */

import { containerNoun, isScalar, preview } from "../scalar.js";

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
 * The same, but it refuses to invent a spelling for a container.
 *
 * `lit()` reaches `String(v)` for "anything exotic", and `String(["ready","approved"])` is
 * `ready,approved` — a plausible-looking string that no row's `status` can equal, so
 * `{not: ["ready","approved"]}` compiled to a predicate every row passes. It parsed, validated,
 * rendered, and filtered NOTHING, and the board it fed reported 42 where the answer was 33.
 *
 * A list has no scalar spelling. Saying so is the whole fix, and it belongs here — at the
 * coercion — rather than in each operator, because every operator that ever compares a value
 * arrives through this function. See `src/scalar.js` for the rule this enforces.
 *
 * `hint` is what the author should have written. Refusing correctly is worth less than refusing
 * with the answer attached: `not_in` sits THREE LINES above `not` in this file, and the author who
 * hit this went and read the source to find it.
 */
export function comparisonValue(v, { field, operator, hint }) {
  if (isScalar(v)) return sqlValue(v);
  throw new ShapeError(
    `filter on "${field}": ${operator} compares one value and got ${containerNoun(v)}, ` +
      `${preview(v)} — ${hint}`,
  );
}

/**
 * "This cell holds nothing" — the one definition of empty, in one place.
 *
 * Frontmatter written by hand and by three different tools disagrees about how to spell empty, so
 * an absent key, a YAML `null`, and the STRINGS "null"/"None"/"" all mean the same thing. This
 * used to be spelled inline in exactly one branch of `where()`, which is why the other three
 * branches each disagreed with it in a different way.
 */
export const EMPTY_SPELLINGS = ["null", "None", ""];

const isEmpty = (col) => `(${col} IS NULL OR ${col} IN (${EMPTY_SPELLINGS.map(lit).join(",")}))`;

/**
 * The same question asked of a JS value rather than a column.
 *
 * `src/shapes/tree.js` needs it to decide whether a row is a root, and used to carry its own copy
 * with a comment promising it "mirrors the null semantics of `where:`". A promise to stay in step
 * is not a mechanism for staying in step: the two were correct only until somebody edited one. An
 * adversarial review found it while checking whether "one definition of empty" was actually true.
 * It was not — there were two, and this export is what makes the claim honest.
 */
export const isEmptyValue = (v) => v == null || EMPTY_SPELLINGS.includes(v);

/**
 * One ELEMENT of an `in:`/`not_in:` list. A nested list is a mistake with no correct reading —
 * `in: [[a, b]]` is one author flattening a list one level too few — so it is named rather than
 * stringified into `'a,b'`, which is what `lit()` would otherwise have produced.
 */
const elementValue = (v, field, operator) =>
  comparisonValue(v, {
    field,
    operator: `\`${operator}:\``,
    hint: "each entry must be a single value, so flatten it",
  });

/** Does an `in:`/`not_in:` list ask about empty? Only a real null does; the string "null" is a value. */
const listHasNull = (list) => list.some((v) => v === null || v === undefined);
const withoutNull = (list) => list.filter((v) => v !== null && v !== undefined);

/**
 * A `where:` block → a SQL predicate.
 *
 * EVERY operator, including the three this table never used to list:
 *
 *   { status: shipped }              → "status" = 'shipped'
 *   { version: 1 }                   → "version" = 1                    (bare: see sqlValue)
 *   { status: { not: shipped } }     → "status" IS NOT 'shipped'
 *   { status: { in: [a, b] } }       → "status" IN ('a','b')
 *   { status: { not_in: [a] } }      → ("status" NOT IN ('a') OR "status" IS NULL)
 *   { parent: null }                 → EMPTY(parent)
 *   { parent: { not: null } }        → NOT EMPTY(parent)
 *   { parent: { in: [a, null] } }    → ("parent" IN ('a') OR EMPTY(parent))
 *   { parent: { not_in: [a, null] } }→ ("parent" NOT IN ('a') AND NOT EMPTY(parent))
 *
 * ...where EMPTY(col) is `isEmpty` above: NULL, or any of EMPTY_SPELLINGS.
 *
 * TWO RULES EXPLAIN ALL OF IT.
 *
 * 1. EXCLUSION IS NULL-SAFE. `not:` and `not_in:` both keep a row that simply lacks the key,
 *    because "not shipped" plainly includes a row with no status at all. `not:` gets this from
 *    `IS NOT`; `not_in:` has to say it out loud with `OR col IS NULL`, since bare `NOT IN` is
 *    three-valued and would drop those rows. Before they were made to agree, `{not: 1}` and
 *    `{not_in: [1]}` — the same question, two spellings — returned different rows.
 *
 * 2. A REAL null IN A LIST MEANS EMPTY; the STRING "null" is just a value. `in: [a, null]` adds
 *    the empty rows, and `not_in: [a, null]` removes them — so there the null-safety of rule 1 is
 *    deliberately NOT applied, because the caller asked for empties to go.
 *
 * `not:` uses `IS NOT` rather than `!=` for rule 1's reason: `NULL != 1` is NULL, so `!=` would
 * drop every row missing the key. The ONE exception is `not: null`, which compiles to
 * `NOT EMPTY(col)` — `IS NOT 'null'` would match three of the four spellings of empty and so
 * return rows that ARE empty.
 *
 * Values go through `sqlValue`, not `lit`, so a numeric or boolean filter compares as its own type
 * against the untyped column the projection built.
 */
export function where(clause) {
  if (!clause) return "1=1";
  const parts = Object.entries(clause).map(([field, test]) => {
    const col = ident(field);
    if (test === null) return isEmpty(col);
    if (typeof test !== "object") return `${col} = ${sqlValue(test)}`;

    // `status: [a, b]` reached the "unsupported filter" throw at the bottom, which named the
    // value and not the fix. The author meant `in:`; say so.
    if (Array.isArray(test)) {
      throw new ShapeError(
        `filter on "${field}": equality compares one value and got a list, ${preview(test)} — ` +
          `use \`${field}: {in: [...]}\` to match any of them`,
      );
    }

    if (Array.isArray(test.in)) {
      const vals = withoutNull(test.in);
      const inList = vals.length
        ? `${col} IN (${vals.map((v) => elementValue(v, field, "in")).join(", ")})`
        : null;
      if (!listHasNull(test.in)) return inList ?? "1=0"; // `in: []` matches nothing, and says so
      return inList ? `(${inList} OR ${isEmpty(col)})` : isEmpty(col);
    }

    if (Array.isArray(test.not_in)) {
      const vals = withoutNull(test.not_in);
      // `NOT IN` is three-valued: a NULL column yields NULL, which is not TRUE, so the row is
      // dropped. `not:` deliberately avoids that with `IS NOT`; this branch has to say the same
      // thing out loud or the two disagree about a row that simply lacks the key.
      const list = vals.map((v) => elementValue(v, field, "not_in")).join(", ");
      if (!listHasNull(test.not_in)) {
        // Rule 1: exclusion is null-safe. Bare `NOT IN` is three-valued — a NULL column yields
        // NULL, which is not TRUE — so a row that simply lacks the key would be dropped, while
        // `not:` keeps it. The `OR ... IS NULL` is what makes the two agree.
        return vals.length ? `(${col} NOT IN (${list}) OR ${col} IS NULL)` : "1=1";
      }
      // Rule 2: an explicit null asks for the empty rows to go, so rule 1's null-safety is
      // deliberately absent here. Emitting it anyway would be DEAD SQL — `NOT EMPTY(col)`
      // already excludes NULL, so `OR col IS NULL` could never change the result. Found by an
      // adversarial review; it was harmless and shipped noise into every such predicate.
      return vals.length
        ? `(${col} NOT IN (${list}) AND NOT ${isEmpty(col)})`
        : `NOT ${isEmpty(col)}`;
    }

    if ("not" in test) {
      // The complement of `field: null` must be the complement, not `IS NOT 'null'` — which
      // matches three of the four spellings of empty and so returns rows that ARE empty.
      if (test.not === null) return `NOT ${isEmpty(col)}`;
      // THE 2026-08-07 SILENT TAUTOLOGY. `{not: ["ready","approved"]}` used to compile to
      // `"status" IS NOT 'ready,approved'` — true for every row, so the filter excluded nothing
      // and nothing said a word. `not_in:` is the operator that works, and it is three lines up.
      return `${col} IS NOT ${comparisonValue(test.not, {
        field,
        operator: "`not:`",
        hint: `use \`${field}: {not_in: [...]}\` to exclude several values`,
      })}`;
    }
    throw new ShapeError(`unsupported filter on "${field}": ${JSON.stringify(test)}`);
  });
  return parts.length ? parts.join(" AND ") : "1=1";
}

/**
 * A column spec → a SQL expression producing its display text.
 *
 *   "id"                                          → COALESCE(replace("id",'|','/'), '')
 *   { from: coord, wrap: "`{}`" }                 → '`' || "coord" || '`'
 *   { from: state, map: {done: shipped, "*": open} } → CASE WHEN ... END
 *   { from: body, section: "The job", truncate: 160 } → md_section("_body", 'The job') truncated
 *   { from: statement, collapse: true }           → collapse_ws("statement")
 *
 * `from: body` is spelled without the underscore because `_body` is an engine detail; a consumer
 * says "the body".
 */
export function column(spec) {
  // The shorthand is the OBJECT FORM with no options, and must render identically. It used to
  // return a bare identifier, which is not the same thing: `rowExpr` joins columns with `||`, and
  // SQLite's `||` propagates NULL, so ONE null column nulled the whole line and the row rendered
  // as a BLANK LINE inside the markdown table. The object form never had this — it wraps every
  // expression in COALESCE.
  //
  // Latent before, systematic now. `where: {x: {not_in: [...]}}` admits rows precisely BECAUSE
  // `x IS NULL`, so any view naming that same column in shorthand rendered those rows blank every
  // single time. Making the filter null-tolerant while leaving the renderer null-hostile would
  // have shipped a corrupt artifact by construction, which is why this rides here rather than in
  // a follow-up. Found by an adversarial review, reproduced end to end through `rollup --check`.
  if (typeof spec === "string") {
    return { expr: `COALESCE(replace(${ident(spec)}, '|', '/'), '')`, as: spec };
  }

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
