/**
 * The programmatic API.
 *
 * `package.json` has declared `exports: { ".": "./src/index.js" }` since the beginning, but the
 * file did not exist — the CLI worked because `bin` points straight at `cli.js`, so nothing
 * exercised the import path and `import { rollup } from "@marktiderman/gitdata"` failed for every
 * consumer. A package that other projects are meant to depend on has to be importable.
 *
 * What is exported here is the contract. Everything else is an implementation detail and may
 * change without a major version.
 */

// Regenerate views, or report drift without writing. diffLines/formatDiff turn a --check drift
// pair (compiled vs. committed) into something readable instead of just a status string.
export { rollup, loadViewSpecs, compileView, diffLines, formatDiff, ViewSpecError } from "./rollup.js";

// Scaffold a `data/` trellis — bare, or from a pack.
export { init, listPacks, PackError } from "./init.js";

// The pipeline, for consumers building their own tooling on top: markdown → tables → SQLite.
export { load, LoadError } from "./load.js";
export { project, query, ProjectError } from "./project.js";
export { parseFrontmatter, FrontmatterError } from "./frontmatter.js";
export { renderTemplate, RenderError } from "./render.js";

// Shapes: the registry, the dispatcher, and the error every shape throws.
export { SHAPES, runShape, ShapeError } from "./shapes/index.js";
