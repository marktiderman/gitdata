---
kind: idea-record
id: I-007
title: "Let a schema declare which files in its directory are rows"
state: open
solves: "A table cannot hold anything but rows. Putting a per-record attachment beside its record — a flightlog next to a task — breaks the store, because every `.md` under the table is loaded as a row and an attachment has no frontmatter. The only escape is an undeclared filename convention that nothing in the schema mentions."
raised: "Session 2026-08-07, Gamify (GamifyEducation/gamify-platform). Wanted flightlogs at `data/tasks/<id>/_flightlog.md`, beside the card they belong to. Operator asked for the config option directly after watching the workaround land."
became: null
verdict: null
tags: [schema, loader, layout, ergonomics]
created: 2026-08-07
---

# Let a schema declare which files in its directory are rows

## Why

The loader recurses into a table's subdirectories and treats every `.md` it finds as a row.
Measured on `data/tasks/`:

```text
data/tasks/12215/flightlog.md    ✗ tasks/12215/flightlog.md: no frontmatter block   (exit 1)
data/tasks/12215/_flightlog.md   ✓ 6 view(s) checked                                (exit 0)
```

The underscore prefix is the only way to put a non-row file inside a table. That works — this is not
a bug report — but it has three costs:

1. **It is invisible.** Nothing in `tasks.schema.yml` says the table has an opinion about
   filenames. A contributor adding `data/tasks/12215/notes.md` gets `no frontmatter block` and no
   hint that a leading underscore is the fix. We found it by trying it.
2. **It overloads one mechanism.** `_template.md`, `_work-contract.md` and `_flightlog.md` are all
   "not a row" for quite different reasons — one is a stencil, one is policy, one is an artifact of
   a specific row. The store cannot tell them apart, so neither can a view.
3. **It rules out the natural layout.** Keeping a record's attachments in a folder named for the
   record is the obvious filing scheme, and today every file in it must be renamed to opt out of
   being data.

The general shape: **a table is a directory, but not everything in the directory is a row**, and
right now that distinction is a naming convention rather than a declaration.

## The shape

A per-schema selector saying which files load as rows. Sketch:

```yaml
table: tasks
rows: "*.md" # default — top level only, current behaviour minus the recursion surprise
```

```yaml
table: tools
rows: "**/*.md" # opt IN to recursion, for stores that want nested rows
```

Anything the selector does not match is simply not data — no error, no frontmatter requirement. The
underscore rule stays as the default exclusion so nothing existing moves.

Two smaller variants, if a glob is more than is wanted:

- `recurse: false` as a schema key, making the current recursion opt-in rather than default.
- `exclude: ["*/_*.md"]`, which declares today's convention without adding a positive selector.

Any of the three would make the rule visible in the schema instead of learned by failure.

## Why it fits the laws

- **The engine stays domain-ignorant.** A file selector is not domain knowledge — it is the same
  category as "a folder is a table". Nothing here teaches the engine what a task or a flightlog is.
- **No new query language.** This is load-time file selection, not template or `where:` syntax. SQL
  is untouched.
- **Determinism is preserved** — provided matched paths are sorted before load, exactly as rows are
  today. A glob that leaked directory order would break the product, and that is the thing to test
  first, not last.
- **The format does not move.** It moves in the other direction: more plain-file layouts become
  legal, and no file needs renaming to stay hand-editable.
- **Core ships zero tables.** This is a schema key, so it travels with packs.

**Where it rubs.** It adds schema surface to solve an ergonomics problem that a filename already
solves. Said plainly so it can be argued: if the answer is "document the underscore rule in
`SHAPES.md` and move on", that is a legitimate close — and cheaper. This row exists because the
rule was undiscoverable, not because the workaround failed.

## Done when

- A schema can state which files under its directory are rows, and a file outside that set is
  ignored rather than erroring.
- `data/tasks/<id>/flightlog.md` — no underscore — loads clean under a schema that says so.
- Byte-identical rollup output across repeated runs on a nested tree, proving the selector did not
  introduce directory-order dependence.
- The default is unchanged behaviour, so no consumer has to touch a schema to keep working.
