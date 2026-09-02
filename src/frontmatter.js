/**
 * Parse a row file into { data, body }.
 *
 * `data` is the YAML frontmatter as a plain object; `body` is everything after the closing
 * fence. Body is returned because views legitimately query it — a view may derive a summary
 * column from a section of the body rather than from frontmatter (see `md_section`).
 *
 * CRLF is accepted alongside LF: a non-LF-normalized checkout writes fences as `---\r\n`,
 * and an LF-only matcher would treat every such file as frontmatter-less.
 *
 * Two spellings reach the same shape: a markdown row fences its YAML and keeps prose after it
 * (`parseFrontmatter`), a `.yml` row is the YAML document and nothing else (`parseYamlDocument`).
 * Which file gets which is `src/load.js`'s call — it owns the row extensions.
 */
import { parse as parseYaml } from "yaml";

// The inner group is optional so the canonical empty block `---\n---\n` parses — GitHub,
// Obsidian, Jekyll, and gray-matter all accept it, and a stub file awaiting metadata must not
// kill the rollup.
const FENCE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

export class FrontmatterError extends Error {}

export function parseFrontmatter(text, { file = "<string>" } = {}) {
  // Editors that save UTF-8 with a BOM prepend U+FEFF, which would stop `^---` matching.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const match = FENCE.exec(text);
  if (!match) throw new FrontmatterError(`${file}: no frontmatter block`);

  let data;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (cause) {
    throw new FrontmatterError(`${file}: unparseable frontmatter — ${cause.message}`);
  }
  // `--- \n ---` parses to null; treat an empty block as an empty mapping rather than an error,
  // but a scalar or list is a real authoring mistake and must fail loud.
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError(`${file}: frontmatter is not a mapping`);
  }

  return { data, body: text.slice(match[0].length) };
}

/**
 * Parse a whole-document YAML row into the same `{ data, body }` a fenced markdown row produces.
 *
 * `body` is `""`, not undefined: a `.yml` row has no prose by construction, and a view reading
 * `_body` off a table holding both spellings must get a string from every row rather than a null
 * from half of them. `md_section("")` then answers "no such section", which is the truth.
 *
 * The parse is deliberately identical in strictness to the fenced one — an empty file is an empty
 * mapping, a scalar or a list is an authoring mistake and fails loud — so moving a row from `.md`
 * to `.yml` cannot quietly change what the loader will accept.
 */
export function parseYamlDocument(text, { file = "<string>" } = {}) {
  // Editors that save UTF-8 with a BOM prepend U+FEFF; the YAML parser reads it as content.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let data;
  try {
    data = parseYaml(text);
  } catch (cause) {
    // The migration mistake, named rather than left to the parser: renaming `x.md` to `x.yml`
    // and keeping its fences reads as two YAML documents, and "implicit map key" tells nobody
    // what to do about it.
    const fenced = FENCE.test(text) ? " — a `.yml` row is the YAML document itself, so remove the `---` fences a `.md` row needs" : "";
    throw new FrontmatterError(`${file}: unparseable YAML — ${cause.message}${fenced}`);
  }
  // An empty document parses to null. Same ruling as an empty frontmatter block: a stub row
  // awaiting its columns is not an error, but a scalar or a list is.
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError(`${file}: YAML document is not a mapping`);
  }

  return { data, body: "" };
}
