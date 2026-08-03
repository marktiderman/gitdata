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
gitdata packs                            # what's available to install
```

Start from nothing in one command:

```bash
npx github:marktiderman/gitdata init --pack feature-management
cp data/features/_template.md data/features/F-001--dark-mode.md   # edit it
npx github:marktiderman/gitdata rollup
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

A view is config, not code — named SQL queries plus a template:

```yaml
kind: view-spec
id: features-board
out: data/_views/features-board.md
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
`{{name.column}}` reads a scalar from the first row.

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

## Status

`init` and `rollup` are built. `validate` is not: nothing checks a row against a schema, so a table
accepts any frontmatter and an unedited template rolls up as real data.

Layers, rules, and the gap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Apache-2.0.
