---
kind: idea-record
id: I-004
title: "Assertions — a query that must return zero rows, or the build fails"
state: open
solves: "gitdata proves a rendered artifact matches its rows. That is self-consistency, and it is green over wrong data by construction. Nothing can assert that the DATA is true."
raised: "Session 2026-08-07 — asked by the operator after PR #15 landed: what would make gitdata 10x better. Also tracked downstream as gamify-platform I-006."
became: null
verdict: null
tags: [assertions, gate, declarative, 10x]
created: 2026-08-07
---

# Assertions — a query that must return zero rows, or the build fails

## Why

gitdata has two declarative layers and is missing a third.

- **Schemas** answer *does a row conform?* — required fields, enums, patterns, refs.
- **Shapes** answer *how do rows become an artifact?* — sections, digest, tree.
- Nothing answers ***must this be true?***

`rollup --check` proves the rendered file matches what the rows would render. That is
**self-consistency**. It can be perfectly green over wrong data, because it only ever proves the
renderer ran.

The defect that produced this repo's first consumer bug report is exactly that shape: a board that
was structurally flawless and semantically lying — reporting 13 rows stale while printing the
current version beside each one. Every gate was green. The data was wrong. There was no layer whose
job was to notice.

## The shape

`data/_assert/*.assert.yml` — a name, a query, a message. Nothing more.

### The cardinality contract, settled

An earlier draft of this row said "an expected cardinality" and then contradicted itself two
sections later. Settling it, because the ambiguity would have been inherited by whoever built it:

**Every assertion is a zero-row assertion. The query names the VIOLATION, and there must be none.**

There is no `expect: N`. It was considered and rejected, and the reason is diagnostic rather than
aesthetic: when `expect: 3` returns 2, the failure hands you a number and nothing to act on. When a
zero-row assertion fails, **the result set IS the diagnosis** — those rows, by name, are exactly
what is wrong. A gate that can tell you *what* to fix instead of only *that* something is wrong is
the difference between this and a row count.

Anything a non-zero cardinality could express is expressible by inverting the query, and inverting
it is what forces the author to name the violation rather than the expectation. "At least N" is
worth refusing outright: it silently tolerates drift upward, which is the exact failure this tool
exists to catch.

Watch what collapses into it:

- **Non-vacuity (I-002)** stops being a special case argued over per-command and becomes an
  assertion a consumer writes once.
- **"No row may be below the current contract version"** — the consumer-side rule that motivated
  the 0.2.1 bug hunt — becomes one file, in the consumer, where the domain knowledge belongs.
- **Several of `doctor`'s 13 checks** are assertions someone had to write in JavaScript because the
  declarative layer could not express them.

## Why it fits the laws

This is the argument for the shape, not just for the feature:

- **The engine stays domain-ignorant.** It learns "run this query, expect nothing back". It never
  learns what `wip` or `ratified` means — the consumer's query carries that, the same way a view's
  `where:` already does.
- **No new query language.** SQL is already the query layer. This adds an *expectation*, not syntax.
  Where a view says `shape:`, an assertion can too.
- **Determinism holds.** Same rows in, same verdict out.
- **The format does not move.** A plain YAML file, hand-editable in the GitHub web UI and Obsidian.

## Done when

A consumer can declare an assertion, `gitdata assert --check` exits non-zero while it is violated
and 0 once satisfied, and the failure names the offending rows rather than only counting them.

**Non-vacuity applies to the assertions, not to their results.** An assertion returning zero rows
is a PASS — that is the entire contract above, and reporting it would make every healthy store
red. What must not pass quietly is a store with **no assertions declared at all**: `gitdata assert`
over an empty `_assert/` directory exits 0 today by the same logic that makes `validate` green over
zero schemas (I-002), and would ship with that defect built in on day one.

So: zero rows returned, pass. Zero assertions defined, finding. Those are different emptinesses,
and an earlier draft of this row conflated them — which is worth recording, because the conflation
read as reasonable right up until someone asked which one `--check` was supposed to fail on.
