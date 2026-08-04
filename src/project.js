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
export class ProjectError extends Error {}

/**
 * Loaded on first `project()`, not on import.
 *
 * At module scope this cost every consumer a WASM engine to reach anything else in the package —
 * `src/index.js` re-exports from here, so `import { isRowFile } from "@marktiderman/gitdata"`
 * initialised SQLite to obtain a three-line predicate. Consumers who only read rows never call
 * `project()` or `query()` at all.
 *
 * `project()` was already async, so deferring costs it nothing: the first call pays what the
 * import used to, and the module is cached for every call after.
 */
let sqlite3ModulePromise;
function loadSqlite() {
  sqlite3ModulePromise ??= import("@sqlite.org/sqlite-wasm").then((m) => m.default);
  return sqlite3ModulePromise;
}

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
  const text = String(body);
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Anchored to the end of the line so `md_section(body, 'The job')` never matches
  // `## The job to be done` — a prefix match silently reads the wrong section.
  const start = new RegExp(`^##\\s+${escaped}\\s*(?:\\r?\\n|$)`, "m").exec(text);
  if (!start) return "";

  // Cut at the next `##` heading, or run to the end of the body. Done in two steps rather than
  // one regex on purpose: JavaScript has no end-of-input anchor usable under the `m` flag (`\Z`
  // is Python's, and in JS silently means a literal "Z"), so a single-regex version fails to
  // match whenever the requested section is the LAST one in the file.
  const rest = text.slice(start.index + start[0].length);
  const next = /^##\s/m.exec(rest);

  return (next ? rest.slice(0, next.index) : rest)
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
  const sqlite3InitModule = await loadSqlite();
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

    // SQLite column names are case-insensitive; `Status:` in one row and `status:` in another
    // would otherwise die inside CREATE TABLE with a raw "duplicate column name" naming
    // neither the table nor the files. Authoring variance deserves a message that does.
    const spellings = new Map();
    for (const c of columns) {
      const key = c.toLowerCase();
      if (spellings.has(key)) {
        throw new ProjectError(
          `table "${name}": frontmatter keys "${spellings.get(key)}" and "${c}" differ only by case — column names are case-insensitive, pick one spelling`,
        );
      }
      spellings.set(key, c);
    }

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
