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

// Check rows against data/_schema/<table>.schema.yml — opt-in, reports only, never blocks.
export { validate, loadSchemas, SchemaSpecError } from "./validate.js";

// The compliance verb: every check in one report, with the consumer's own severity policy applied.
// CHECKS is the catalog (id + default level); readPolicy reads data/_gitdata.yml; exitCode holds
// the --check/--strict contract in one place so nothing can drift from it.
export { doctor, readPolicy, exitCode, CHECKS, CHECK_IDS, LEVELS, TABLE_CLASSES, POLICY_FILE, runCommands } from "./doctor.js";

// Multi-store enumeration: every data/ trellis below a root, and what each one holds.
export { findStores, describeStores } from "./stores.js";

// Emit .github/CODEOWNERS from data/<table>/_owners.yml, or report drift without writing.
// NOTE the semantic, which `doctor` warns about but does not change: emitCodeowners REPLACES the
// whole output file (src/emit-codeowners.js:138). It does not merge, and it does not append.
export { emitCodeowners, codeownersLines, renderCodeowners, EmitError } from "./emit-codeowners.js";

// The pipeline, for consumers building their own tooling on top: markdown → tables → SQLite.
export { load, LoadError } from "./load.js";
// The row contract, for consumers that write into `data/` rather than only read it: which files
// are rows, and where they are. Without these a consumer reimplements them, and a reimplementation
// that disagrees with the loader is a silent data loss on one side or a phantom row on the other.
export { isRowFile, rowFilesIn, escapedRowFiles } from "./load.js";
export { project, query, ProjectError } from "./project.js";
export { parseFrontmatter, FrontmatterError } from "./frontmatter.js";
export { renderTemplate, RenderError } from "./render.js";

// Shapes: the registry, the dispatcher, and the error every shape throws.
export { SHAPES, runShape, ShapeError } from "./shapes/index.js";

// Introspection: table/column/type discovery, and the guarded read-only SQL escape hatch behind
// the `tables`/`query` CLI commands.
export { describeTables, runQuery, assertReadOnly, QueryError } from "./introspect.js";
