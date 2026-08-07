# Changelog

This file exists because of what it records below.

A change to `where:` altered which rows four operators return — silently, inside generated,
drift-checked documents — and there was **no artifact in which a consumer could learn it had
happened.** An adversarial review looked for a changelog, a migration note, an upgrade guide, and
found that the repository had never had one. That absence was the finding, not an oversight in the
PR.

Entries are newest first, and each one answers the only question a consumer upgrading actually has:
**does my output change, and how do I tell?**

---

## Unreleased

### Changed — a container handed to a scalar comparison is now refused, not answered

**This is a behaviour change, and it is the loud kind on purpose.** A `where:` clause that
compares a column against a **list or a map** now throws `ShapeError` at compile time instead of
producing a predicate. If a view of yours starts failing on upgrade, it was not filtering what you
thought it was.

Measured on the 45 real task rows of `GamifyEducation/gamify-platform`, 2026-08-07:

| you wrote | before | after |
| --- | --- | --- |
| `status: {not: [ready, approved]}` | `"status" IS NOT 'ready,approved'` — **true for every row**, so the filter excluded nothing and the board it fed reported 42 where the answer was 33 | `ShapeError: filter on "status": \`not:\` compares one value and got a list … — use \`status: {not_in: [...]}\` to exclude several values` |
| `status: [a, b]` | `ShapeError: unsupported filter` — named the value, not the fix | names `in:` |
| `status: {in: [[a, b]]}` | `"status" IN ('a,b')` | `ShapeError … each entry must be a single value, so flatten it` |
| `enum: {tags: [...]}` over a list column | **44 issues, one per row**, accusing every row — including the row whose tags were entirely inside the allowed set | **one** issue, aimed at the schema line: `enum compares whole values, and "tags" holds a list in 44 of 44 row(s) … those rows can never match, whatever they contain` |
| `ref: {tags: sprints.id}` over a list column | 44 issues, same shape | one, same shape |

`unique:` and `required:` are unchanged and deliberately so: neither coerces a container, so
neither was ever lying.

The refusals carry the fix, not just the refusal. `not_in` sits three lines above `not` in
`src/shapes/sql.js`, and the author who hit this went and read the source to find it.

### Added — `GD113 rule-compared-nothing`, and `rules` in the `validate` report

`validate` reported zero issues for two unrelated reasons and spelled them identically: every row
was asked and passed, or **no row was ever asked**. `validate()` now also returns `rules` — every
(rule, column) it ran and how many rows each one actually compared — and `doctor` reads it as
GD113. This is [I-002] one level down: I-002 is a *gate* that checked nothing, GD113 is a *rule*
that checked nothing inside a full store.

**`warn`, not `error`, and narrowed twice**, because a check that fires on correct code gets
`|| true` appended to it in CI:

- A column that is **written and blank** does not fire — a schema ahead of its data is how a store
  grows. Only a column **no row carries at all** does. (Found by watching it fire on the shipped
  pack's own quickstart.)
- A table with **no rows** produces one finding, not one per rule.

Silent on the real 4-table Gamify store; fires on `sprint:` → `sprnit:`.

`gitdata validate` prints the same advisory line and **does not change its exit code** for it.

## 0.4.0

### Changed — `where:` now has one definition of "empty", and it changes which rows you get

**This is a behaviour change. Your generated artifacts may differ with no change to your rows.**
If `rollup --check` goes red immediately after upgrading, that is expected: regenerate, read the
diff, and commit it.

`(col IS NULL OR col IN ('null','None',''))` was spelled inline in exactly **one** branch of
`where()` — `field: null` — and the other operators each disagreed with it differently. Now every
operator asks the same `isEmpty`, and `EMPTY_SPELLINGS` is the single exported list.

Measured on six rows: `1`, `2`, a row with **no such key**, `'null'`, `'None'`, `''`.

| filter | before | after | changed |
| --- | --- | --- | --- |
| `{v: null}` | `c,d,e,f` | `c,d,e,f` | no |
| `{v: {not: null}}` | `a,b,c,e,f` | `a,b` | **yes** |
| `{v: {not: 1}}` | `b,c,d,e,f` | `b,c,d,e,f` | no |
| `{v: {not_in: [1]}}` | `b,d,e,f` | `b,c,d,e,f` | **yes** |
| `{v: {in: [1, null]}}` | `a,d` | `a,c,d,e,f` | **yes** |
| `{v: {not_in: [1, null]}}` | `b,e,f` | `b` | **yes** |
| `{v: {in: [null]}}` | `d` | `c,d,e,f` | **yes** |
| `{v: {not_in: [null]}}` | `a,b,e,f` | `a,b` | **yes** |
| `{v: {not_in: ['null']}}` | `a,b,e,f` | `a,b,c,e,f` | **yes** |

**The two you are most likely to feel:**

- **`not_in:` now keeps rows that lack the key.** No null needs to appear anywhere in your view —
  `not_in: [shipped]` alone changed. A bare `NOT IN` is three-valued, so a NULL column yielded
  NULL, not TRUE, and the row was dropped — while `not:` deliberately kept it via `IS NOT`. The
  same question in two spellings gave two answers. A row missing an optional key is the ordinary
  case, so **"everything except these statuses" views will gain rows.**
- **`not: null` now returns the true complement of `field: null`.** It compiled to `IS NOT 'null'`,
  which matches three of the four spellings of empty — so "not empty" **returned rows that were
  empty**. This set gets *smaller*. Together with the above, an upgrading consumer can see movement
  in both directions in one document.

Shapes are affected because they all build predicates through `where()`: `sections` and `digest`
counts move, and `tree` can gain a **"Could not be placed"** block when a row newly admitted by
`not_in` has a parent that is still excluded. `doctor`'s **GD109** flips pass → error for exactly
as long as it takes you to regenerate.

**Why 0.4.0 and not 0.3.2.** `0.3.2` satisfies `^0.3.1`, so it would have reached every consumer on
a caret range without anyone deciding to take it. `0.4.0` does not, which forces the upgrade to be
deliberate. For a change that alters query results this is the minimum defensible bump.

**Two corrections to this entry's own first draft**, kept visible rather than quietly edited,
because both were exactly the error this project exists to catch:

- **Four of six cells in the table above were wrong.** The first version was labelled "measured on
  six rows" and was not: the numbers came from an earlier three-row fixture and were carried over
  by hand. The narrative held — `not: null` really did return rows that are empty — but the figures
  offered as proof had never been run. An adversarial review re-ran them; the table above is now
  the output of that run, both columns, on the fixture it names.
- **`in: []` / `not_in: []` are not a behaviour change.** The first draft called the `1=0` / `1=1`
  change a fix for "broken SQL". SQLite accepts `IN ()` and `NOT IN ()` and returns the same rows
  either way — verified by executing both. It is a readability and portability improvement only.

### Fixed

- `{field: {not: null}}` is now the exact complement of `{field: null}` — disjoint, and together
  covering the table. Closes #16.
- `not:` and `not_in:` agree about rows that lack the key.
- `tree`'s root detection shared none of this: it carried a private copy of the four spellings with
  a comment promising it "mirrors the null semantics of `where:`". A promise is not a mechanism —
  it now imports `isEmptyValue`, so the two cannot drift.

### Fixed — a `columns:` shorthand no longer renders a row as a blank line

`columns: [id, status]` returned a **bare identifier**, while the object form `{from: status}`
wrapped every expression in `COALESCE`. `rowExpr` joins columns with `||`, and SQLite's `||`
propagates NULL — so **one** null column nulled the entire line and the row came out as a blank
line inside the markdown table. No error, no warning, just a gap where a row should be.

Latent for as long as the shorthand has existed. This release made it **systematic**: `not_in:`
now admits rows precisely *because* the tested column is NULL, so a view naming that same column
in shorthand rendered those rows blank every single time. Shipping the null-tolerant filter
without the null-tolerant renderer would have produced a corrupt artifact by construction.

The shorthand now emits what the object form always did. Output is unchanged except where it was
already broken: a NULL value, or a value containing `|` (which previously escaped unsanitised into
the table and broke the column layout).

### Added

- `EMPTY_SPELLINGS` and `isEmptyValue`, exported from `src/shapes/sql.js`.
