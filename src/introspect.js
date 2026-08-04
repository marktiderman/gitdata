/**
 * Introspection for agents: what tables exist, what they contain, and a raw SQL escape hatch —
 * built on the same load()/project() pipeline `rollup()` uses internally. No folder-walking or
 * SQLite projection is reimplemented here (see src/load.js, src/project.js).
 *
 * This is the "discovery" half of the CLI: an agent landing cold on an unfamiliar gitdata repo
 * should be able to run `gitdata tables` and know what it can query, then `gitdata query` to ask
 * it directly — rule 3 (SQL is the query layer) applied to the terminal, not just to view specs.
 */
import { load } from "./load.js";
import { project, query } from "./project.js";

export class QueryError extends Error {}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * A column's inferred type: the distinct SQLite storage classes (`typeof()`) actually found in
 * its non-null values, not a declared type — columns are created with no type affinity (see
 * project.js), so a declared type would say nothing. Multiple storage classes report joined and
 * sorted (`integer|text`); an all-null column reports `null`.
 */
function inferColumnType(db, table, column) {
  const rows = query(db, `SELECT DISTINCT typeof(${quoteIdent(column)}) AS t FROM ${quoteIdent(table)}`);
  const types = [...new Set(rows.map((r) => r.t))].filter((t) => t !== "null").sort();
  return types.length === 0 ? "null" : types.join("|");
}

/**
 * List every table (folder) with its columns, inferred types, and row count.
 *
 * Sorted by table name, then by column name within each table — deterministic (law 4) regardless
 * of directory listing order or SQLite's internal column order, which follows first-appearance in
 * the frontmatter and would otherwise vary row to row.
 *
 * @param {string} dataRoot
 * @returns {Promise<Array<{table: string, rows: number, columns: Array<{name: string, type: string}>}>>}
 */
export async function describeTables(dataRoot) {
  const tables = load(dataRoot);
  const db = await project(tables);
  try {
    return [...tables.keys()].sort().map((name) => {
      const { rows } = tables.get(name);
      // Mirrors project.js's own column discovery (union of frontmatter keys, `_file` guaranteed)
      // so what this reports matches what a query against the table actually sees.
      const columns = new Set(rows.flatMap(Object.keys));
      columns.add("_file");
      return {
        table: name,
        rows: rows.length,
        columns: [...columns].sort().map((column) => ({ name: column, type: inferColumnType(db, name, column) })),
      };
    });
  } finally {
    db.close();
  }
}

// A denylist, not a security boundary (see CLAUDE.md: gitdata guides, GitHub enforces — and this
// isn't even a GitHub-facing control). `query` is a convenience for an operator or agent reading
// their own repo's in-memory projection, not a sandboxed endpoint; it only needs to catch an
// honest mistake — a stray UPDATE — before it runs.
const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|reindex|grant|revoke|begin|commit|rollback|savepoint|release)\b/i;

/**
 * Reject anything that is not clearly a read. Returns the single trimmed statement on success;
 * throws QueryError otherwise.
 *
 * The single-statement check splits on `;`, which a string literal containing a semicolon would
 * defeat — an accepted gap for a convenience guard, not a sandbox.
 */
export function assertReadOnly(sql) {
  const statements = String(sql ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) throw new QueryError("query: empty SQL statement");
  if (statements.length > 1) {
    throw new QueryError('query: only a single SQL statement is allowed (found more than one, separated by ";")');
  }
  const [stmt] = statements;
  if (!/^(select|with|explain)\b/i.test(stmt)) {
    throw new QueryError("query: only read-only statements are allowed — must start with SELECT, WITH, or EXPLAIN");
  }
  const hit = WRITE_KEYWORDS.exec(stmt);
  if (hit) {
    throw new QueryError(`query: "${hit[0]}" looks like a write — this is a read-only escape hatch`);
  }
  return stmt;
}

/**
 * Run a guarded read-only SQL statement against the same in-memory projection `rollup()` builds.
 *
 * @param {string} dataRoot
 * @param {string} sql
 * @returns {Promise<Array<object>>}
 */
export async function runQuery(dataRoot, sql) {
  const stmt = assertReadOnly(sql);
  const db = await project(load(dataRoot));
  try {
    return query(db, stmt);
  } finally {
    db.close();
  }
}
