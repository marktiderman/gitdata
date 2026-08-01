/**
 * Project loaded tables into an ephemeral in-memory SQLite database.
 *
 * The database is scratch paper. It is built from the markdown on every run, queried, and
 * discarded — git remains the only durable store. Nothing here is ever persisted, which is why
 * `@sqlite.org/sqlite-wasm`'s in-memory-only limitation under Node is a non-issue.
 *
 * Column discovery is the union of frontmatter keys across a table's rows, so a table needs no
 * declared schema to be queryable. Values that are not SQL scalars (lists such as `tags`,
 * nested maps) are stored as JSON text and stay reachable via SQLite's json_each/json_extract.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Frontmatter values are richer than SQL scalars; flatten the rest to JSON text. */
function toSqlValue(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return JSON.stringify(v);
}

/**
 * Collapse all whitespace runs to single spaces and trim.
 *
 * Registered as a SQL function because YAML block scalars (`statement: >`) fold content across
 * lines, and a digest line must be one line. Mirrors the reference implementation's
 * `re.sub(r"\s+", " ", value).strip()`.
 */
function collapseWs(value) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Extract one markdown section from a body and flatten it to a single line.
 *
 * `md_section(body, 'The job')` returns the text under `## The job`, up to the next `##` heading,
 * with blank lines and nested headings dropped and the remainder joined by spaces.
 *
 * Generic on purpose: the function knows what a markdown section is, never what "The job" means.
 * Which heading to read is the view's business, i.e. the consumer's.
 */
function mdSection(body, heading) {
  if (body == null || heading == null) return null;
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, "m").exec(String(body));
  if (!match) return "";

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join(" ");
}

/**
 * A lexically sortable key for dotted identifiers, so `1.10` sorts after `1.9` rather than after
 * `1.1`. Numeric segments are zero-padded and prefixed `0`; non-numeric segments are prefixed `1`
 * so they sort after numbers at the same position.
 */
function naturalKey(value) {
  if (value == null) return null;
  return String(value)
    .split(".")
    .map((seg) => (/^\d+$/.test(seg) ? `0${seg.padStart(10, "0")}` : `1${seg}`))
    .join(".");
}

export async function project(tables) {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const db = new sqlite3.oo1.DB(":memory:");

  // Scalar helpers for the text work SQL cannot express. Each is domain-agnostic — the engine
  // learns what a markdown section or a dotted id is, never what a "feature" or "The job" is.
  db.createFunction("collapse_ws", (_ctx, v) => collapseWs(v), { arity: 1, deterministic: true });
  db.createFunction("md_section", (_ctx, body, heading) => mdSection(body, heading), {
    arity: 2,
    deterministic: true,
  });
  db.createFunction("natural_key", (_ctx, v) => naturalKey(v), { arity: 1, deterministic: true });

  for (const { name, rows } of tables.values()) {
    const columns = [...new Set(rows.flatMap(Object.keys))];
    // A table with no rows still gets created — a view querying it should return nothing,
    // not fail with "no such table". `_file` guarantees at least one column exists.
    if (!columns.includes("_file")) columns.push("_file");

    db.exec(`CREATE TABLE ${quoteIdent(name)} (${columns.map(quoteIdent).join(", ")})`);
    if (rows.length === 0) continue;

    const placeholders = columns.map(() => "?").join(", ");
    const stmt = db.prepare(
      `INSERT INTO ${quoteIdent(name)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`,
    );
    try {
      for (const row of rows) {
        stmt.bind(columns.map((c) => toSqlValue(row[c])));
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }
  }

  return db;
}

/**
 * Run a query and return rows as plain objects.
 *
 * sqlite-wasm hands back null-prototype objects; they are re-created with `{...r}` so callers get
 * ordinary objects that compare, spread, and serialize without surprises.
 */
export function query(db, sql) {
  const rows = [];
  db.exec({ sql, rowMode: "object", callback: (r) => rows.push({ ...r }) });
  return rows;
}
