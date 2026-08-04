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

export class SchemaSpecError extends Error {}

const RULE_KEYS = ["required", "unique", "enum", "pattern", "ref"];

/** Frontmatter absence, YAML `null`, and an empty string all mean "nothing was written here". */
const isMissing = (v) => v === undefined || v === null || v === "";

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

/** `required: [col, ...]` — every row must have a non-empty value. */
function checkRequired(rows, table, columns) {
  const issues = [];
  for (const column of columns) {
    for (const row of rows) {
      if (isMissing(row[column])) {
        issues.push({ table, file: row._file, rule: "required", column, message: `missing "${column}"` });
      }
    }
  }
  return issues;
}

/** `unique: [col, ...]` — no two rows may share a value; missing values are never compared. */
function checkUnique(rows, table, columns) {
  const issues = [];
  for (const column of columns) {
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
  return issues;
}

/** `enum: {col: [allowed, ...]}` — a present value must be one of the declared set. */
function checkEnum(rows, table, spec) {
  const issues = [];
  for (const [column, allowed] of Object.entries(spec)) {
    const allowedSet = new Set(allowed);
    for (const row of rows) {
      if (isMissing(row[column])) continue;
      if (!allowedSet.has(row[column])) {
        issues.push({
          table,
          file: row._file,
          rule: "enum",
          column,
          message: `"${row[column]}" is not one of ${allowed.join(", ")}`,
        });
      }
    }
  }
  return issues;
}

/** `pattern: {col: regex}` — a present value must match, as a whole-string RegExp test. */
function checkPattern(rows, table, spec, schemaFile) {
  const issues = [];
  for (const [column, pattern] of Object.entries(spec)) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch (cause) {
      throw new SchemaSpecError(`${schemaFile}: invalid pattern for "${column}" — ${cause.message}`);
    }
    for (const row of rows) {
      if (isMissing(row[column])) continue;
      if (!re.test(String(row[column]))) {
        issues.push({
          table,
          file: row._file,
          rule: "pattern",
          column,
          message: `"${row[column]}" does not match /${pattern}/`,
        });
      }
    }
  }
  return issues;
}

/**
 * `ref: {col: "table.column"}` — a present value must equal some row's value in that column, in
 * that table. The foreign-key-style check a plain frontmatter file cannot enforce on its own: a
 * `parent` that names no row, or a join column with a typo, rolls up silently otherwise.
 */
function checkRef(rows, table, spec, tables, schemaFile) {
  const issues = [];
  for (const [column, target] of Object.entries(spec)) {
    const dot = String(target).indexOf(".");
    if (dot < 1 || dot === target.length - 1) {
      throw new SchemaSpecError(`${schemaFile}: ref "${column}: ${target}" must be "table.column"`);
    }
    const refTable = target.slice(0, dot);
    const refColumn = target.slice(dot + 1);
    const refRows = tables.get(refTable)?.rows ?? [];
    const values = new Set(refRows.map((r) => r[refColumn]).filter((v) => !isMissing(v)));

    for (const row of rows) {
      if (isMissing(row[column])) continue;
      if (!values.has(row[column])) {
        issues.push({
          table,
          file: row._file,
          rule: "ref",
          column,
          message: `"${row[column]}" has no matching ${refTable}.${refColumn}`,
        });
      }
    }
  }
  return issues;
}

/**
 * Validate every table that has a schema file, against the same loaded model `rollup` projects
 * into SQL — `load()`'s tables map — without needing SQLite for row-level checks.
 *
 * @param {{dataRoot: string}} opts
 * @returns {{tables: string[], issues: Array<{table: string, file: string, rule: string, column: string, message: string}>}}
 */
export function validate({ dataRoot }) {
  const schemas = loadSchemas(dataRoot);
  if (schemas.length === 0) return { tables: [], issues: [] };

  const tables = load(dataRoot);
  const issues = [];

  for (const schema of schemas) {
    const rows = tables.get(schema.table)?.rows ?? [];
    if (schema.required) issues.push(...checkRequired(rows, schema.table, schema.required));
    if (schema.unique) issues.push(...checkUnique(rows, schema.table, schema.unique));
    if (schema.enum) issues.push(...checkEnum(rows, schema.table, schema.enum));
    if (schema.pattern) issues.push(...checkPattern(rows, schema.table, schema.pattern, schema._file));
    if (schema.ref) issues.push(...checkRef(rows, schema.table, schema.ref, tables, schema._file));
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

  return { tables: schemas.map((s) => s.table), issues };
}
