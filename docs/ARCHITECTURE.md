# Architecture

Three layers. The boundary between them is what lets one engine serve repos that share no
vocabulary.

## The layers

| layer | lives in | knows | never knows |
| --- | --- | --- | --- |
| **Engine** | `src/*.js` | files, frontmatter, SQL, rendering, drift | what a column *means* |
| **Shapes** | `src/shapes/` | nesting, sections, digests, ordering, orphans | what a table is *called* |
| **Packs** | `packs/` | tables, columns, templates, views | how any of it *runs* |

```text
packs  →  shapes  →  engine
```

A pack configures shapes; a shape composes engine primitives. Nothing points back up.

## The rules

**1. The engine names nothing.** No table name, column name, or status value in `src/`.
`md_section()` knows what a markdown section is, never what "The job" means. Vocabulary leaks one
comment at a time, so `test/boundaries.test.js` enforces this.

**2. A shape is a capability, not a report.** "Walk a hierarchy and show what didn't fit" is a
shape. "The Q3 board" is a pack's view. A shape that only suits one repo's data belongs in that
repo as SQL.

**3. A pack is a starting point.** What it installs belongs to the installing repo immediately.
Packs are copied, never linked — there is no update path, so editing your copy is the point.

**4. Generated artifacts are never hand-edited.** `rollup --check` fails when a committed artifact
differs from what its sources compile to. Hand-editing an artifact and editing a source without
re-rolling are the same defect; both are caught.

**5. gitdata guides; GitHub enforces.** The CLI reports and emits, never blocks. Blocking is
branch protection, CODEOWNERS, and required checks.

## Where does my change go?

- How markdown, YAML, SQL, or drift-checking behaves → **engine**
- A way to turn rows into an artifact, useful to a repo you have never seen → **shape**
- What *your* things are called → **pack**, or your own repo
- Needed SQL in a view spec → a shape is missing. [File it](../CONTRIBUTING.md).

## Data layout

```text
data/
  <table>/            folder = table
    <row>.md          file = row · frontmatter = columns
    2026/01/<row>.md  nested rows belong to <table>; shard freely
    _template.md      `_` prefix = never a row
    README.md         documents the table; never a row
  _views/             view specs and the artifacts they generate
  _schema/            table contracts (reserved — see below)
```

Column discovery is the union of frontmatter keys across a table's rows, so a table needs no
declaration to be queryable: make a folder, add a row, query it.

**A table may nest.** Rows at any depth belong to the table folder at the top; a subfolder is a
shard, not a table of its own, and only the first level under `data/` names a table. `_file`
carries the row's path relative to its table, so two shards may hold same-named files. Sharding by
date is how a table outgrows one directory — the loader used to read only the top level and drop
those rows with no error, which is the failure this project exists to prevent.

## Not built: `validate`

Nothing checks that a row has the fields its table expects, that an `id` is unique, that a
`parent` resolves, or that a copied `_template.md` was filled in — an unedited template rolls up
as real data. `data/_schema/` is reserved for this and read by nothing today.

gitdata currently guarantees that **artifacts match sources**, not that **sources are well-formed**.

## Packs and versioning

A pack declares its version and the engine range it works against:

```yaml
name: feature-management
version: 0.1.0
requires: ">=0.1.0"
```

Packs ship in this repo today. The direction is a registry: packs published and versioned
independently, so a table contract can evolve without an engine release. `listPacks()` is the seam
a registry client would attach to.
