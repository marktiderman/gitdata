---
kind: idea-record
id: I-001
title: "Declare column types in the projection instead of discarding them"
state: open
solves: "The projection knows every value's type at load time and throws it away, so every comparison against a column is a chance to reintroduce the 0.2.1 `where:` defect. Typing the column fixes the class; typing the value fixes one instance."
raised: "Session 2026-08-07, delivering the 0.2.1 `where:` fix (PR #15) — the root cause found while writing that patch, and NOT addressed by it."
became: null
verdict: null
tags: [projection, sql, correctness, root-cause]
created: 2026-08-07
---

# Declare column types in the projection instead of discarding them

## Why

`src/project.js` already knows what every value is. `toSqlValue` deliberately flattens booleans to
`1`/`0`, passes numbers through, and JSON-encodes the rest. Then the very next thing it does is
emit a table with no types at all:

```sql
CREATE TABLE "tasks" ("_file", "id", "contract_version")
```

No declared type means BLOB (no) affinity, which means SQLite converts **neither** operand of a
comparison. That is the whole mechanism behind the 0.2.1 defect: `contract_version` stored as
INTEGER could never equal the TEXT literal `'1'`, so `{not: 1}` returned every row instead of the
non-matching ones — silently, with no error and no empty result to notice.

PR #15 fixed the **value** side: `sqlValue()` now emits numbers and booleans bare, so a `where:`
comparison arrives typed. That is correct and it closed the reported bug. It is also a fix at the
boundary. The column is still typeless, so the next place a value meets a column — a future shape,
a `compile:` escape hatch, a join — gets to rediscover the same trap.

Fix the class, not the instance.

## The shape

Infer each column's type from the values actually loaded and declare it: `INTEGER` where every
non-null value is an integer, `REAL` for numerics, `TEXT` otherwise. Mixed columns stay untyped,
which is the honest answer for a column that genuinely holds both.

The inference is already half-written — `describeTables` reports an inferred type per column today,
so the engine can name the type it refuses to declare.

## Why it fits the laws

- **Domain-ignorant.** "This column holds integers" is a fact about values, not about what a
  feature or a task is.
- **No new query language.** Nothing about the view syntax changes.
- **Determinism.** The union of rows is already sorted at load; type inference over a deterministic
  set is deterministic.
- **Format unmoved.** Frontmatter is untouched — this is entirely inside the ephemeral projection.

The one real risk is a **behaviour change**: a column that inference calls INTEGER starts comparing
differently against a quoted string than it does today. That is the point, and it is why this is an
idea rather than a patch — it wants a release boundary and a stated migration note, not a quiet
landing.

## Done when

`PRAGMA table_info` reports a non-empty `type` for every column whose values agree, a mixed column
still reports empty, and the 0.2.1 regression suite passes **with `sqlValue()` reverted** — which
would prove the class is closed rather than the instance patched.
