/**
 * What gitdata can compare, and what it must refuse to compare.
 *
 * THE RULE, in one sentence: **a comparison that returns the same answer for every possible
 * input is not a check.** Whether that constant answer happens to be "pass" or "fail" is an
 * accident of implementation, not a fact about the data — and both spellings are equally a lie,
 * because in both cases the question was never asked.
 *
 * Frontmatter holds lists and maps. Every comparison gitdata offers — `enum`, `ref`, `pattern`,
 * and every `where:` operator — is a SCALAR comparison. Hand one a container and the container
 * gets coerced to a string on its way to the comparison, at which point the answer is fixed:
 *
 *   Set(["a","b"]).has(["a"])            → always false   → `enum` fails EVERY list-valued row
 *   Set(ids).has(["a"])                  → always false   → `ref`  fails EVERY list-valued row
 *   String(["ready","approved"])         → 'ready,approved'
 *     ...so `{not: ["ready","approved"]}` emits `"status" IS NOT 'ready,approved'`, which no row
 *        can ever fail, so the filter excludes nothing and the board silently overcounts.
 *
 * MEASURED, 2026-08-07, on the 45 real task rows of GamifyEducation/gamify-platform. All three
 * are one disease: a container reached a scalar comparison and gitdata answered anyway.
 *
 * The coercion is where the information is lost, so the coercion is where the refusal belongs.
 * `String(list)` is especially dangerous because it produces a PLAUSIBLE-LOOKING string —
 * `'ready,approved'` reads like a value someone meant to write, which is why three separate
 * post-mortems of this defect (including the commit message that named it) each misidentified
 * the branch it came from. The engine had the value, knew its type, and said nothing.
 *
 * Domain-ignorant by construction: "this is a list, not a scalar" is a fact about a JavaScript
 * value. Nothing here has heard of a task, a tag, or a status.
 */

/**
 * A value SQL and gitdata's row-level rules can compare.
 *
 * `null`/`undefined` count: "this cell holds nothing" is a legitimate operand everywhere — `where:`
 * gives it its own null-safe semantics, and the row-level rules skip it. What is NOT comparable is
 * a container: an array or a plain object.
 *
 * A `Date` is scalar because `project.js`'s `toSqlValue` already flattens it to `YYYY-MM-DD`
 * losslessly for comparison purposes, unlike a list.
 */
export const isScalar = (v) =>
  v == null ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  typeof v === "bigint" ||
  v instanceof Date;

/** "a list" / "a map" — the noun a message needs, without leaking JS type names at an author. */
export const containerNoun = (v) => (Array.isArray(v) ? "a list" : "a map");

/**
 * A container rendered short enough to sit inside a one-line message.
 *
 * JSON rather than `String(v)` on purpose: `String(["a","b"])` is `a,b`, which is exactly the
 * plausible-looking coercion this module exists to stop, and reprinting it in the error message
 * would hide the very thing the author needs to see.
 */
export function preview(v, max = 48) {
  const s = JSON.stringify(v) ?? String(v);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
