# Shapes — the mechanics gitdata owns

A **shape** is a rollup capability. gitdata implements it; a consumer configures an instance of it.

The line: **gitdata owns the mechanics, the consumer owns the naming.** A consumer never writes a
recursive CTE, a tie-break key, or an orphan predicate — those are the same everywhere, so they are
fixed once here. A consumer says what its things are called.

If a view spec in a consumer repo contains SQL, that is extension, and it means a shape is missing.

## The three shapes

| shape | answers | proved against |
| --- | --- | --- |
| `sections` | "list these rows, filtered and sorted, under headings, as markdown tables" | Genesis `cleanse-board` |
| `digest` | "render these rows as formatted lines, block by block" — and, via `counts:`, "count these things and put the numbers in a sentence" | Genesis `ccp-digest` |
| `tree` | "walk a parent→child hierarchy, indented, with orphans" | Genesis `cleanse-territories` |

## How a view declares one

A `queries:` entry is either a SQL string or a shape declaration. Both produce rows whose first
column is a line, so `{{name}}` substitutes them identically and one view may mix the two.

```yaml
queries:
  body:
    shape: tree
    from: features
    line: ["- ", { from: title }]
    order: { by: coord, mode: natural }
    orphans:
      heading: "## Could not be placed"
```

`tree` classifies an unplaceable row by **reachability from a root**, not by whether its `parent`
resolves. That is deliberate: a cycle (`a → b → a`) has resolvable parents and no path to any root,
so a resolve-only check would drop both rows silently. Every row is emitted exactly once — in the
tree, or under `orphans:`.

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

A `queries:` entry may be a raw SQL string instead of a shape. That exists for genuinely one-off
artifacts, and every use is a signal that a shape is missing or too narrow. Prefer filing the gap.

The packs bundled with gitdata still hand-write their SQL: they were authored while `shape:` was
unreachable from a view spec, so they are all escape hatch and none of them exercise a shape.
Porting them is the standing test of whether these three shapes are the right three.
