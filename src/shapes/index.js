/**
 * Shape dispatch — the registry that makes `shape:` reachable from a view spec.
 *
 * A view's `queries:` entry is either a SQL string (the escape hatch) or a shape declaration.
 * Both resolve to the same thing: rows whose first column is a line of the artifact, which is
 * what `renderTemplate` already substitutes for `{{name}}`. Shapes therefore need no change to
 * the renderer, and a view may mix the two freely.
 *
 * Until this file existed the shape modules were unreachable: `rollup.js` read `queries` as SQL
 * only, so every shipped view spec hand-wrote the SQL that shapes exist to remove.
 */
import { digest } from "./digest.js";
import { sections } from "./sections.js";
import { ShapeError } from "./sql.js";
import { tree } from "./tree.js";

/** name → (db, spec) => string[] */
export const SHAPES = { sections, digest, tree };

/**
 * Run one shape declaration and return rows in the renderer's shape.
 *
 * Lines are wrapped as `{ line }` rows rather than returned bare so that a shape and a SQL query
 * are indistinguishable downstream — `renderTemplate` takes the first column of each row either
 * way, and `{{name}}` behaves identically.
 */
export function runShape(db, spec) {
  const name = spec.shape;
  if (!name) throw new ShapeError(`query object needs a "shape" (one of: ${Object.keys(SHAPES).join(", ")})`);
  const fn = SHAPES[name];
  if (!fn) throw new ShapeError(`unknown shape "${name}" — available: ${Object.keys(SHAPES).join(", ")}`);
  return fn(db, spec).map((line) => ({ line }));
}

export { ShapeError };
