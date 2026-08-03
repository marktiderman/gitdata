/**
 * Parse a markdown file into { data, body }.
 *
 * `data` is the YAML frontmatter as a plain object; `body` is everything after the closing
 * fence. Body is returned because views legitimately query it — a view may derive a summary
 * column from a section of the body rather than from frontmatter (see `md_section`).
 *
 * CRLF is accepted alongside LF: a non-LF-normalized checkout writes fences as `---\r\n`,
 * and an LF-only matcher would treat every such file as frontmatter-less.
 */
import { parse as parseYaml } from "yaml";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class FrontmatterError extends Error {}

export function parseFrontmatter(text, { file = "<string>" } = {}) {
  const match = FENCE.exec(text);
  if (!match) throw new FrontmatterError(`${file}: no frontmatter block`);

  let data;
  try {
    data = parseYaml(match[1]);
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
