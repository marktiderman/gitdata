# GitDATA

**Dependable, structured, organized docs as data in git that agents and owners can trust.**

The purpose, plainly: a system to track our docs as data.

---

## The north star

> GitDATA - Dependable, structured, organized docs as data in git that agents and owners can trust.
>
> 1. SSOT - ensure a single source of truth so agents can trust they are looking at the correct version especially when they are grepping with speed and running quickly down the critical context path
> 2. organized content. - where files should live. (anyting within the gitdata system (ie the /data/ folder structure) must follow these rules)
> 3. structured metadata - what each file should containt. critical structured content must exist as frontmatter.
> 4. folder scheme exists
> 5. permissions - who is allowed to make changes. (leverage the best of github out of the box features for this,  ie based on folders we can declare code owners. Github PRs require approval for certain files to be
> 6. driftproof - rollups create the current state based on metadata, folder structure.
> 7. Flexible.  can be extended and used for any purpose that needs dependable structured context

## The law

**GitDATA guides. GitHub enforces.**

GitDATA declares the rules, validates against them, reports what is wrong, and emits GitHub
configuration. **It never blocks.** Blocking is GitHub's job — branch protection, CODEOWNERS,
required checks. That split is what keeps this a thin tool instead of a policy engine.

A consequence worth stating plainly: **guidance is only as strong as the enforcement wired to it.**
Install GitDATA without configuring branch protection and you have advice, not governance.

## How it works

```
read data/ → parse frontmatter → load each folder as a table
           → run each view's SQL → render → write the file → discard the database
```

Folder = table. File = row. Frontmatter = columns. Git is the transaction log.

The database is **scratch paper** — it lives in memory for about a second and is thrown away. Git
remains the only durable store. Nothing to host, back up, or keep in sync.

Queries are plain **SQL**, because SQL has solved filtering, joining, grouping, and walking trees
for fifty years, and inventing a query language in YAML is how small tools become large ones.

## Usage

```bash
gitdata init --pack feature-management   # scaffold tables, templates and a board
gitdata rollup                           # regenerate every view
gitdata rollup --check                   # compile in memory, report drift, write nothing
gitdata validate                         # check rows against data/_schema/*.schema.yml
gitdata doctor                           # one compliance report — always exits 0
gitdata doctor --check                   # the one CI line: exit 1 on any error finding
gitdata emit codeowners                  # write .github/CODEOWNERS from data/*/_owners.yml
gitdata emit codeowners --check          # report drift, write nothing
gitdata stores                           # every data/ trellis in the repo, and what is in it
gitdata packs                            # what's available to install
```

Tables live in `<root>/data`. A repo that needs a **second** store says where with `--data`:

```bash
gitdata rollup --data data/generated     # tables at data/generated/, not data/generated/data/
```

Every command that reads tables takes it, so no two of them can disagree about what the data is.
Reach for it when one set of rows is hand-authored and another is rewritten wholesale by a
generator: a single `rollup` regenerating both is wrong, and separate roots is how you say so.
`--root` keeps its other jobs either way — it stays the boundary a view's `out:` may not escape,
and where `emit codeowners` writes and anchors its patterns.

Start from nothing in one command:

```bash
npx @marktiderman/gitdata init --pack feature-management
cp data/features/_template.md data/features/F-001--dark-mode.md   # edit it
npx @marktiderman/gitdata rollup
```

`data/_views/features-board.md` now exists, generated from your files:

```markdown
# Features

**3 features** · 2 in flight · 1 shipped · 1 P0 outstanding

## Building

| priority | id | title | owner | the job |
| --- | --- | --- | --- | --- |
| P0 | F-001 | Dark mode | alex | Let people use the app at night without burning their eyes. |
```

Everything `init` writes is **yours** — edit the template, rewrite the view, add fields. Re-running
`init` never overwrites a file that already exists.

`--check` is the driftproof guarantee. Put it in CI: a hand-edited board, or a source edit that was
never rolled up, fails the build. It exits non-zero so **you** decide whether that blocks a merge.

## A view

A view is config, not code — named queries plus a template. Each query is either a **shape**
declaration (see [SHAPES.md](SHAPES.md)) or a raw SQL string, shown here:

```yaml
kind: view-spec
id: p0-board
out: data/_views/p0-board.md
queries:
  rows: |
    SELECT '| ' || id || ' | ' || title || ' |' AS line
    FROM features WHERE priority = 'P0' ORDER BY id
  total: |
    SELECT COUNT(*) AS n FROM features WHERE priority = 'P0'
template: |
  # P0 features ({{total.n}})

  | id | title |
  | --- | --- |
  {{rows}}
```

Two substitutions, deliberately no more: `{{name}}` joins a result set's first column by newline,
`{{name.column}}` reads a scalar from the first row. A shape returns `{ line }` rows, so it is
always read with `{{name}}`; a SQL string returns whatever it selected, so `{{total.n}}` above
reads that query's `n` column.

**The engine knows** how to filter, sort, group, join, walk trees, count, and render.
**The engine does not know** what a "feature" is, or what your status values mean. That lives in
your schemas and your views — which are yours.

## SQL functions

SQLite provides the query language; GitDATA adds a few scalar helpers for text work SQL cannot
express. Each is domain-agnostic — the engine learns what a markdown section is, never what your
data means.

| function | does |
| --- | --- |
| `collapse_ws(text)` | fold whitespace runs to single spaces and trim — YAML block scalars span lines, a digest line does not |
| `md_section(body, heading)` | pull one `## heading` section out of a file body and flatten it to a line |
| `natural_key(text)` | sortable key for dotted ids, so `1.10` sorts after `1.9` rather than after `1.1` |

## Validating rows

A table's contract is optional, and lives beside its data: `data/_schema/<table>.schema.yml`.

```yaml
kind: table-schema
required: [id, title, status]
unique: [id]
enum:
  status: [idea, planned, building, shipped, dropped]
pattern:
  id: "^F-\\d{3}$"
ref:
  parent: features.id
```

```bash
gitdata validate
```

reads every `data/_schema/*.schema.yml`, checks that table's rows, and exits non-zero — like
`rollup --check` — if any rule fails, naming the table, the row's file, the rule, and why. A table
with no schema file is simply not checked; a repo with no `data/_schema/` at all passes with zero
issues. `required`, `unique`, `enum`, `pattern`, and `ref` (a foreign-key-style check against
another table's column) are all the vocabulary the engine knows — same as SQL functions, more
never gets added here. What columns get which rules is your call, declared in your schema, never
baked into gitdata itself.

## One CI line: `doctor`

`rollup --check` and `validate` each answer one question and each need their own CI step. `doctor`
folds them in — as findings `GD109` and `GD110` — alongside the checks nothing could make before:
is the engine pinned, does the lockfile agree with the manifest, does an installed pack's engine
range still admit the engine that is running, does a generated artifact land somewhere the loader
will read back as a row.

```bash
gitdata doctor            # report. ALWAYS exits 0 — safe in a dev shell
gitdata doctor --check    # exit 1 if any finding is an error
gitdata doctor --strict   # --check, and warnings count too
```

Every check has a stable public ID. You may lower any of them in `data/_gitdata.yml`, but lowering
one requires a written `reason:`, and every lowered check is reprinted in a **silenced by policy**
block with that reason. A tool you cannot tell "we meant that" gets ignored; one that records *why*
keeps the divergence visible and attributed instead of silent.

```yaml
engine: ">=0.3.0"
checks:
  GD103: { level: off, reason: "generated artifacts live elsewhere by design" }
```

A check that could not run is never reported as passing — it prints under **not checked** with the
gap named. The full catalog, every default severity, and the store taxonomy: **[docs/DOCTOR.md](docs/DOCTOR.md)**.

## Status

`init`, `rollup`, `validate`, `doctor`, `stores`, and `emit codeowners` are built.

`emit codeowners` reads `data/<table>/_owners.yml` and writes `.github/CODEOWNERS` — a table with
no `_owners.yml` gets no line; ownership is opt-in, never inferred:

```bash
gitdata emit codeowners           # write .github/CODEOWNERS from data/*/_owners.yml
gitdata emit codeowners --check   # CI: has ownership drifted from what's committed?
```

What is still direction, not capability: required-check wiring (turning `gitdata rollup --check`,
`gitdata validate`, and `gitdata emit codeowners --check` into GitHub branch-protection rules is
still a manual repo setting, not something gitdata configures for you) and ownership for anything
outside `data/` — a repo-wide catch-all, `/README.md`, `/CLAUDE.md` — which stays hand-authored in
the same file.

Layers, rules, and the gap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Apache-2.0.
