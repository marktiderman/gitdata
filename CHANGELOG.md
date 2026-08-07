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

## 0.4.0

### Changed — `where:` now has one definition of "empty", and it changes which rows you get

**This is a behaviour change. Your generated artifacts may differ with no change to your rows.**
If `rollup --check` goes red immediately after upgrading, that is expected: regenerate, read the
diff, and commit it.

`(col IS NULL OR col IN ('null','None',''))` was spelled inline in exactly **one** branch of
`where()` — `field: null` — and the other operators each disagreed with it differently. Now every
operator asks the same `isEmpty`, and `EMPTY_SPELLINGS` is the single exported list.

Measured on six rows: `1`, `2`, a row with **no such key**, `'null'`, `'None'`, `''`.

| filter | before | after |
| --- | --- | --- |
| `{v: null}` | `c,d,e,f` | `c,d,e,f` — unchanged |
| `{v: {not: null}}` | `a,c,d,e` | **`a,b`** |
| `{v: {not: 1}}` | `b,c,d,e,f` | `b,c,d,e,f` — unchanged |
| `{v: {not_in: [1]}}` | `b` | **`b,c,d,e,f`** |
| `{v: {in: [1, null]}}` | `a` | **`a,c,d,e,f`** |
| `{v: {not_in: [1, null]}}` | `b` | `b` — unchanged |

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

**Not a behaviour change, despite an earlier claim:** `in: []` and `not_in: []` now emit `1=0` and
`1=1`, and the original write-up called that a fix for "broken SQL". It was not. SQLite accepts
`IN ()` and returns the same rows either way — verified by executing it. The change is
readability and portability only.

### Fixed

- `{field: {not: null}}` is now the exact complement of `{field: null}` — disjoint, and together
  covering the table. Closes #16.
- `not:` and `not_in:` agree about rows that lack the key.
- `tree`'s root detection shared none of this: it carried a private copy of the four spellings with
  a comment promising it "mirrors the null semantics of `where:`". A promise is not a mechanism —
  it now imports `isEmptyValue`, so the two cannot drift.

### Added

- `EMPTY_SPELLINGS` and `isEmptyValue`, exported from `src/shapes/sql.js`.
