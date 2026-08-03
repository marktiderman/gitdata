/**
 * The gitdata engine, as a library.
 *
 * `package.json`'s `exports` map has always pointed here; the file did not exist, so
 * `import "@gitdata/core"` failed with ERR_MODULE_NOT_FOUND while the `gitdata` bin worked
 * fine. Consumers that only shell out to the CLI never noticed. This makes the declared
 * contract true.
 *
 * The CLI is one caller of this surface, not the only one: a consumer embedding the rollup
 * in its own tooling wants `rollup()` without spawning a process, and `parseFrontmatter` /
 * `load` / `project` are useful on their own for "read my docs as rows".
 *
 * Deliberately a flat re-export with no logic. Anything that belongs to a command rather
 * than the engine stays in `cli.js`.
 */
export { parseFrontmatter, FrontmatterError } from "./frontmatter.js";
export { load } from "./load.js";
export { project, query } from "./project.js";
export { renderTemplate, RenderError } from "./render.js";
export { rollup, loadViewSpecs, compileView, ViewSpecError } from "./rollup.js";
export { init, listPacks, PackError } from "./init.js";
