/**
 * The programmatic API.
 *
 * `package.json` has declared `exports: { ".": "./src/index.js" }` since the beginning, but the
 * file did not exist — the CLI worked because `bin` points straight at `cli.js`, so nothing
 * exercised the import path and `import { rollup } from "@gitdata/core"` failed for every
 * consumer. A package that other projects are meant to depend on has to be importable.
 *
 * What is exported here is the contract. Everything else is an implementation detail and may
 * change without a major version.
 */

// Regenerate views, or report drift without writing.
export { rollup, loadViewSpecs, compileView, ViewSpecError } from "./rollup.js";

// Scaffold a `data/` trellis — bare, or from a pack.
export { init, listPacks, PackError } from "./init.js";

// The pipeline, for consumers building their own tooling on top: markdown → tables → SQLite.
export { load } from "./load.js";
export { project, query } from "./project.js";
export { parseFrontmatter, FrontmatterError } from "./frontmatter.js";
export { renderTemplate, RenderError } from "./render.js";

// Shapes: the registry, the dispatcher, and the error every shape throws.
export { SHAPES, runShape, ShapeError } from "./shapes/index.js";
