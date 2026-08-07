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

`data/_assert/*.assert.yml` — a name, a query, an expected cardinality, a message. Nothing more.

Watch what collapses into it:

- **Non-vacuity (I-002)** stops being a special case argued over per-command and becomes an
  assertion a consumer writes once.
- **"No row may be below the current contract version"** — the consumer-side rule that motivated
  the 0.2.1 bug hunt — becomes one file, in the consumer, where the domain knowledge belongs.
- **Several of `doctor`'s 13 checks** are assertions someone had to write in JavaScript because the
  declarative layer could not express them.

## Why it fits the laws

This is the argument for the shape, not just for the feature:

- **The engine stays domain-ignorant.** It learns "a query and an expected count". It never learns
  what `wip` or `ratified` means — the consumer's schema and the consumer's assertion carry that.
- **No new query language.** SQL is already the query layer. This adds an *expectation*, not syntax.
  Where a view says `shape:`, an assertion can too.
- **Determinism holds.** Same rows in, same verdict out.
- **The format does not move.** A plain YAML file, hand-editable in the GitHub web UI and Obsidian.

## Done when

A consumer can declare an assertion, `gitdata assert --check` exits non-zero while it is violated
and 0 once satisfied, the message names the rows that failed rather than only the count, and an
assertion over an empty result set is itself reported rather than silently passing (I-002's rule
applies to this command too, or it inherits the same defect on day one).
