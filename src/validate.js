/**
 * `gitdata validate` — check loaded rows against a table's declared contract.
 *
 * `data/_schema/<table>.schema.yml` was reserved since the loader existed but read by nothing —
 * a table accepted any frontmatter, a copied `_template.md` rolled up as real data the moment its
 * placeholders survived a rename, and nothing caught a duplicate id or a `parent` pointing nowhere.
 * This file is the missing middle verb of the project's own law: gitdata declares, VALIDATES,
 * reports, and emits GitHub config.
 *
 * The vocabulary lives here and nowhere else: `required`, `unique`, `enum`, `pattern`, `ref`. What
 * a table is called, which columns it has, and what its values mean is domain knowledge — it lives
 * in the schema file (or a pack), never in this module. This engine would validate a table called
 * `widgets` exactly as readily as one called `features`; it has never heard of either.
 *
 * Schema is opt-in, like everything else gitdata reports: a table with no `<table>.schema.yml` is
 * not checked, and a repo with no `data/_schema/` directory passes with zero issues. gitdata guides;
 * it never blocks — `validate` exits non-zero so the *consumer* can wire that into a required CI
 * check, exactly like `rollup --check`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { load } from "./load.js";
import { containerNoun, isScalar, preview } from "./scalar.js";

export class SchemaSpecError extends Error {}

const RULE_KEYS = ["required", "unique", "enum", "pattern", "ref"];

/** Frontmatter absence, YAML `null`, and an empty string all mean "nothing was written here". */
const isMissing = (v) => v === undefined || v === null || v === "";

/**
 * How many rows a rule actually COMPARED — the non-vacuity counter.
 *
 * A rule reports zero issues for two completely different reasons, and until this existed the
 * report spelled them identically: every row was asked and every row passed, or **no row was ever
 * asked**. `enum: {ownre: [...]}` — one transposed letter — is skipped by `isMissing` on every
 * row and reports a clean pass forever. This is [I-002] one level down: I-002 is about a GATE
 * that checked nothing; this is about a RULE that checked nothing inside a full store.
 *
 * Counted, not inferred, and counted at the comparison itself rather than by re-deriving which
 * rows "should" have been skipped — a second copy of the skip logic is a second thing to drift.
 */
const tally = () => ({ evaluated: 0, skipped: 0, declared: 0 });

/**
 * A rule whose column holds a container cannot compare anything, so it does not get to report
 * per-row issues that blame the DATA for a defect in the SCHEMA.
 *
 * `enum: {tags: [...]}` over 45 real task rows produced 44 issues reading
 * `"prd-063,port-hygiene" is not one of ...` — including for the row whose tags were ENTIRELY
 * inside the allowed set. Every row fails, whatever it holds; the answer is constant, so it is
 * not a check. One finding, aimed at the schema line that cannot work, replaces 44 aimed at rows
 * that are fine.
 */
function containerIssue({ rule, table, column, sample, count, total, schemaFile, hint }) {
  return {
    table,
    file: schemaFile,
    rule,
    column,
    message:
      `${rule} compares whole values, and "${column}" holds ${containerNoun(sample)} in ` +
      `${count} of ${total} row(s) (e.g. ${preview(sample)}) — those rows can never match, ` +
      `whatever they contain. ${hint}`,
  };
}

/**
 * Walk a column once, splitting rows three ways: missing (skipped by every rule), container
 * (uncomparable — one schema-level finding), and comparable (handed to `compare`).
 *
 * Shared so the three scalar rules cannot disagree about which rows they looked at, which is how
 * `where:`'s four operators each ended up with their own definition of empty.
 */
function scanColumn({ rows, table, column, rule, schemaFile, hint }, compare) {
  const issues = [];
  const stat = { rule, table, column, ...tally() };
  let containers = 0;
  let sample;

  for (const row of rows) {
    const value = row[column];
    // `declared` counts the KEY, not the value. A row that writes `parent:` with nothing after it
    // has declared the column and left it empty; a store where the key appears in no row at all
    // has a column that does not exist. Both make a rule compare zero rows, and only the second
    // one is a mistake — see GD113 in src/doctor.js for why that distinction is the whole check.
    if (column in row) stat.declared += 1;
    if (isMissing(value)) {
      stat.skipped += 1;
      continue;
    }
    if (!isScalar(value)) {
      if (containers === 0) sample = value;
      containers += 1;
      continue;
    }
    stat.evaluated += 1;
    const message = compare(value);
    if (message) issues.push({ table, file: row._file, rule, column, message });
  }

  if (containers > 0) {
    issues.push(
      containerIssue({ rule, table, column, sample, count: containers, total: rows.length, schemaFile, hint }),
    );
  }
  return { issues, stat };
}

/**
 * Read `<dataRoot>/_schema/*.schema.yml`, sorted by filename for deterministic reporting.
 *
 * The table a schema governs is named by its filename (`features.schema.yml` → `features`), the
 * same convention `_views/<id>.view.yml` already uses. A `table:` field is optional and, if
 * present, must agree — catching a copy-pasted schema nobody renamed.
 */
export function loadSchemas(dataRoot) {
  const dir = join(dataRoot, "_schema");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.yml"))
    .sort()
    .map((file) => {
      const spec = parseYaml(readFileSync(join(dir, file), "utf8"));
      if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new SchemaSpecError(`${file}: schema must be a mapping`);
      }

      const table = file.replace(/\.schema\.yml$/, "");
      if (spec.table != null && spec.table !== table) {
        throw new SchemaSpecError(
          `${file}: "table: ${spec.table}" disagrees with its filename — rename the file or the field`,
        );
      }

      for (const key of Object.keys(spec)) {
        if (key !== "kind" && key !== "table" && !RULE_KEYS.includes(key)) {
          throw new SchemaSpecError(`${file}: unknown rule "${key}" — one of ${RULE_KEYS.join(", ")}`);
        }
      }

      return { ...spec, table, _file: file };
    });
}

/**
 * `required: [col, ...]` — every row must have a non-empty value.
 *
 * The one rule that is never vacuous by construction: it asks about ABSENCE, so every row is
 * evaluated and a container is a perfectly good answer. It does not go through `scanColumn`
 * precisely because it must NOT skip the missing rows — they are the finding.
 */
function checkRequired(rows, table, columns) {
  const issues = [];
  const stats = [];
  for (const column of columns) {
    stats.push({ rule: "required", table, column, evaluated: rows.length, skipped: 0, declared: rows.length });
    for (const row of rows) {
      if (isMissing(row[column])) {
        issues.push({ table, file: row._file, rule: "required", column, message: `missing "${column}"` });
      }
    }
  }
  return { issues, stats };
}

/**
 * `unique: [col, ...]` — no two rows may share a value; missing values are never compared.
 *
 * Containers are fine here and deliberately kept: uniqueness compares a value to ITSELF via
 * `JSON.stringify`, never to a scalar the author wrote, so two rows carrying the same list are
 * genuinely a duplicate and always were. Nothing is coerced, so nothing is lost.
 */
function checkUnique(rows, table, columns) {
  const issues = [];
  const stats = [];
  for (const column of columns) {
    const present = rows.filter((r) => !isMissing(r[column])).length;
    const declared = rows.filter((r) => column in r).length;
    stats.push({ rule: "unique", table, column, evaluated: present, skipped: rows.length - present, declared });
    const byValue = new Map(); // stringified value -> row files that carry it
    for (const row of rows) {
      if (isMissing(row[column])) continue;
      const key = JSON.stringify(row[column]);
      if (!byValue.has(key)) byValue.set(key, []);
      byValue.get(key).push(row._file);
    }
    for (const [key, files] of byValue) {
      if (files.length < 2) continue;
      for (const file of files) {
        const others = files.filter((f) => f !== file).join(", ");
        issues.push({
          table,
          file,
          rule: "unique",
          column,
          message: `duplicate value ${key} for "${column}" — also in ${others}`,
        });
      }
    }
  }
  return { issues, stats };
}

/**
 * `enum: {col: [allowed, ...]}` — a present value must be one of the declared set.
 *
 * `Set(["unity","rn"]).has(["unity"])` is FALSE for every list, so before `scanColumn` this rule
 * accused all 45 real task rows of holding a bad `tags` value — including the row whose tags were
 * entirely inside the allowed set. There is no elementwise enum in gitdata's vocabulary today, so
 * the hint says what the author can actually do rather than naming a rule that does not exist.
 */
function checkEnum(rows, table, spec, schemaFile) {
  const issues = [];
  const stats = [];
  for (const [column, allowed] of Object.entries(spec)) {
    const allowedSet = new Set(allowed);
    const r = scanColumn(
      {
        rows,
        table,
        column,
        rule: "enum",
        schemaFile,
        hint: "`enum` has no elementwise form — check a scalar column, or drop the rule.",
      },
      (v) => (allowedSet.has(v) ? null : `"${v}" is not one of ${allowed.join(", ")}`),
    );
    issues.push(...r.issues);
    stats.push(r.stat);
  }
  return { issues, stats };
}

/** `pattern: {col: regex}` — a present value must match, as a whole-string RegExp test. */
function checkPattern(rows, table, spec, schemaFile) {
  const issues = [];
  const stats = [];
  for (const [column, pattern] of Object.entries(spec)) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch (cause) {
      throw new SchemaSpecError(`${schemaFile}: invalid pattern for "${column}" — ${cause.message}`);
    }
    const r = scanColumn(
      {
        rows,
        table,
        column,
        rule: "pattern",
        schemaFile,
        // `String(["a","b"])` is `a,b`, so a pattern against a list tests a comma-joined string
        // the author never wrote — it can pass or fail for reasons unrelated to the data.
        hint: "a pattern against a list tests its comma-joined spelling, which is not the data.",
      },
      (v) => (re.test(String(v)) ? null : `"${v}" does not match /${pattern}/`),
    );
    issues.push(...r.issues);
    stats.push(r.stat);
  }
  return { issues, stats };
}

/**
 * `ref: {col: "table.column"}` — a present value must equal some row's value in that column, in
 * that table. The foreign-key-style check a plain frontmatter file cannot enforce on its own: a
 * `parent` that names no row, or a join column with a typo, rolls up silently otherwise.
 */
function checkRef(rows, table, spec, tables, schemaFile) {
  const issues = [];
  const stats = [];
  for (const [column, target] of Object.entries(spec)) {
    const dot = String(target).indexOf(".");
    if (dot < 1 || dot === target.length - 1) {
      throw new SchemaSpecError(`${schemaFile}: ref "${column}: ${target}" must be "table.column"`);
    }
    const refTable = target.slice(0, dot);
    const refColumn = target.slice(dot + 1);
    const refRows = tables.get(refTable)?.rows ?? [];
    const values = new Set(refRows.map((r) => r[refColumn]).filter((v) => !isMissing(v)));

    const r = scanColumn(
      {
        rows,
        table,
        column,
        rule: "ref",
        schemaFile,
        // Same shape as `enum`: `Set(ids).has(["a","b"])` is false for every list, so this rule
        // used to accuse every list-valued row of pointing nowhere.
        hint: `"${column}" would need one value per row to reference ${refTable}.${refColumn}.`,
      },
      (v) => (values.has(v) ? null : `"${v}" has no matching ${refTable}.${refColumn}`),
    );
    issues.push(...r.issues);
    stats.push(r.stat);
  }
  return { issues, stats };
}

/**
 * Validate every table that has a schema file, against the same loaded model `rollup` projects
 * into SQL — `load()`'s tables map — without needing SQLite for row-level checks.
 *
 * `rules` is the second half of the report and the reason this function is worth reading twice:
 * it names every (rule, column) the schemas declared and **how many rows each one actually
 * compared**. `issues` alone cannot distinguish "every row was asked and passed" from "no row was
 * ever asked", and those are the two things a green gate must never spell identically. `doctor`
 * reads it as GD113; `--json` exposes it verbatim.
 *
 * @param {{dataRoot: string}} opts
 * @returns {{tables: string[], issues: Array<{table: string, file: string, rule: string, column: string, message: string}>, rules: Array<{table: string, rule: string, column: string, evaluated: number, skipped: number}>}}
 */
export function validate({ dataRoot }) {
  const schemas = loadSchemas(dataRoot);
  if (schemas.length === 0) return { tables: [], issues: [], rules: [] };

  const tables = load(dataRoot);
  const issues = [];
  const rules = [];
  const take = (r) => {
    issues.push(...r.issues);
    rules.push(...r.stats);
  };

  for (const schema of schemas) {
    const rows = tables.get(schema.table)?.rows ?? [];
    if (schema.required) take(checkRequired(rows, schema.table, schema.required));
    if (schema.unique) take(checkUnique(rows, schema.table, schema.unique));
    if (schema.enum) take(checkEnum(rows, schema.table, schema.enum, schema._file));
    if (schema.pattern) take(checkPattern(rows, schema.table, schema.pattern, schema._file));
    if (schema.ref) take(checkRef(rows, schema.table, schema.ref, tables, schema._file));
  }

  // Sorted so a report never depends on rule-declaration order or a Map's iteration order —
  // determinism is the product, the same guarantee `load()` gives rollup by sorting rows.
  issues.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      String(a.file).localeCompare(String(b.file)) ||
      a.rule.localeCompare(b.rule) ||
      a.column.localeCompare(b.column),
  );
  rules.sort(
    (a, b) =>
      a.table.localeCompare(b.table) || a.rule.localeCompare(b.rule) || a.column.localeCompare(b.column),
  );

  return { tables: schemas.map((s) => s.table), issues, rules };
}
