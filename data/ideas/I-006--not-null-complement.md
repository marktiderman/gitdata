---
kind: idea-record
id: I-006
title: "`{field: {not: null}}` is not the complement of `{field: null}`"
state: became
solves: "`{parent: null}` and `{parent: {not: null}}` should partition a table and instead overlap on three of five rows, so a view asking for rows that HAVE a parent gets back mostly parentless ones."
raised: "Session 2026-08-07 — found while delivering the 0.2.1 `where:` fix (PR #15), deliberately excluded from it, and filed separately."
became: "#16"
verdict: null
tags: [sql, where, correctness, null]
created: 2026-08-07
---

# `{field: {not: null}}` is not the complement of `{field: null}`

## Why

`where()` gives `null` special handling on the equality side, deliberately matching all four
spellings of empty because frontmatter written by hand and by three tools disagrees about how to
spell it. The negated form gets no such handling — `null` falls through to `lit()`, before and after
PR #15.

Measured on five rows, one per spelling of empty plus one genuinely populated:

```text
{parent: null}        => ("parent" IS NULL OR "parent" IN ('null','None','')) => ["a","b","c","d"]
{parent: {not: null}} => "parent" IS NOT 'null'                               => ["a","c","d","e"]
```

Those two should partition the table. They **overlap on `a`, `c` and `d`** — three rows that
`{parent: null}` just declared empty are returned by the filter asking for *not* empty. The only row
correctly included is `e`; the only one correctly excluded is `b`, the literal string `'null'`,
which is the row a consumer least likely meant.

Same failure signature as the 0.2.1 defect: the query runs, returns wrong rows, nothing warns.

## The shape

Negate the same predicate the positive branch builds, so the two stay complements by construction
rather than by two authors remembering to keep them in step:

```js
if (test !== null && "not" in test && test.not === null)
  return `(${col} IS NOT NULL AND ${col} NOT IN ('null','None',''))`;
```

The test worth writing is not "each side returns the right rows" but **"the two result sets are
disjoint and together cover the table"** — that is the assertion that would have caught this, and it
stays true if the four-spellings list ever grows.

Left undecided on purpose: whether `not_in: [null, ...]` deserves the same treatment. Not measured,
no opinion, flagged so it is decided rather than inherited.

## Why it fits the laws

A semantics fix inside `where()`. Domain-ignorant, no syntax change, deterministic, format
untouched. It IS a behaviour change, which is why it was kept out of the 0.2.1 fix release rather
than folded in — a P0 should not wait on a semantics debate.

## Done when

Filed upstream as issue #16 with the reproduction above and this suggested shape. Closes when a PR
lands making the two filters exact complements, pinned by a disjoint-and-covering test.
