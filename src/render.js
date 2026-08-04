/**
 * Render query results into a view artifact.
 *
 * A view is a template plus named queries. The template carries the literal prose an artifact
 * needs (headers, framing sentences, fenced blocks); the queries supply the rows. Two
 * substitutions, deliberately no more — this is a template, not a language:
 *
 *   {{name}}         every row of `name`, first column, joined by newlines
 *   {{name.column}}  the first row's `column`, as a scalar
 *
 * Anything a template cannot express uses a view's `compile:` escape hatch instead of growing
 * this syntax.
 */
const TOKEN = /\{\{\s*([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?\s*\}\}/g;

export class RenderError extends Error {}

export function renderTemplate(template, results) {
  return template.replace(TOKEN, (_match, name, column) => {
    const rows = results[name];
    if (rows === undefined) throw new RenderError(`template references unknown query "${name}"`);

    if (column) {
      if (rows.length === 0) throw new RenderError(`query "${name}" returned no rows for {{${name}.${column}}}`);
      if (!Object.hasOwn(rows[0], column)) throw new RenderError(`query "${name}" has no column "${column}"`);
      return String(rows[0][column] ?? "");
    }

    return rows
      .map((row) => {
        const first = Object.values(row)[0];
        return first == null ? "" : String(first);
      })
      .join("\n");
  });
}
