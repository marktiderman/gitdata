# Shapes — the mechanics gitdata owns

A **shape** is a rollup capability. gitdata implements it; a consumer configures an instance of it.

The line: **gitdata owns the mechanics, the consumer owns the naming.** A consumer never writes a
recursive CTE, a tie-break key, or an orphan predicate — those are the same everywhere, so they are
fixed once here. A consumer says what its things are called.

If a view spec in a consumer repo contains SQL, that is extension, and it means a shape is missing.

## The four shapes

| shape | answers | proved against |
| --- | --- | --- |
| `table` | "list these rows, filtered and sorted, as a markdown table" | Genesis `cleanse-board` |
| `stats` | "count these things and put the numbers in a sentence" | `cleanse-board` header |
| `digest` | "render these rows as formatted lines, block by block" | Genesis `ccp-digest` |
| `tree` | "walk a parent→child hierarchy, grouped, with orphans" | Genesis `cleanse-territories` |

## What every shape handles for you

These are the things that look easy and are not. Each was a real defect found by adversarial review
of a hand-written SQL view; each is now fixed once, here, for every consumer.

- **Deterministic ties.** Rows sharing a sort value must not depend on insertion order, or a drift
  check reports failure at random on a different checkout. Every shape appends a tie-break key.
- **Natural vs lexical ordering.** `1.10` sorts after `1.9` under `natural`, after `1.1` under
  `lexical`. Both are legitimate; the consumer picks, per view.
- **Empty sections.** A heading over zero rows is drift. Sections collapse unless the consumer
  declares a placeholder.
- **Body-derived columns.** `{ from: body, section: "The job" }` extracts a markdown section and
  flattens it to one line — including when that section runs to the end of the file.
- **Value mapping.** `{ map: { ratified: agent-proposed, "*": needs-clarify } }` — a stored value
  and its display label are different things.

## Escape hatch

A view may declare `query:` with raw SQL instead of a shape. That exists for genuinely one-off
artifacts, and every use is a signal that a shape is missing or too narrow. Prefer filing the gap.
