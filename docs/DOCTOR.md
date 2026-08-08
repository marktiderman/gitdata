# `gitdata doctor` — the check catalog

One command, one report, one exit code.

```bash
gitdata doctor                  # report. ALWAYS exits 0 — safe in a dev shell, safe in a hook
gitdata doctor --check          # exit 1 if any finding is an error
gitdata doctor --strict         # --check, and warnings count too
gitdata doctor --json           # { findings, silenced, skipped, summary: { error, warn, off } }
gitdata doctor --offline        # skip the one check that contacts the registry
gitdata doctor --root <dir>     # a repo other than the working directory
```

**gitdata guides; GitHub enforces** ([ARCHITECTURE](ARCHITECTURE.md) rule 5). `doctor` reports.
Only `--check` and `--strict` exit non-zero, so **you** decide whether that blocks a merge. Nothing
`doctor` runs writes into `data/`, or anywhere else — it is read-only, in every mode.

It **delegates rather than reimplements**: `rollup --check` arrives as GD109 and `validate` as
GD110, so one CI line covers what used to take three, and there is no second copy of either
behaviour to drift.

## The catalog

Every check has a stable public ID. The ID never changes meaning, so a suppression written today
still means the same thing in a year.

| ID | check | default | what it means |
| --- | --- | --- | --- |
| `GD000` | suppression-without-reason | error | the policy file lowers a check with no `reason:`, or is otherwise malformed. The lowering is **ignored** and the check keeps its default level |
| `GD001` | unpinned-runner | error | a runner invokes `@marktiderman/gitdata` with no `@<version>`. `--check` compares bytes, so a floating engine turns a build red with no change in your own repo |
| `GD002` | install-disagrees | error | `package.json` declares the dependency but it is absent from `node_modules`, or the lockfile pins a version outside the declared range, or `node_modules` and the lockfile disagree |
| `GD003` | unscoped-package | error | a runner or install command names the **unscoped** registry package instead of the scoped one. Unscoped, that name is an unrelated 2016 package by another author |
| `GD004` | behind-latest | warn | the installed engine is behind the latest published version. The only check that uses the network; skipped under `--offline` |
| `GD005` | pack-engine-range | error | an installed pack's `requires:` range excludes the running engine |
| `GD006` | node-below-engines | error | the running node is outside `@marktiderman/gitdata`'s own `engines.node` |
| `GD007` | engine-range-unsatisfied | error | the running engine is outside the `engine:` range this store declares |
| `GD103` | artifact-lands-in-a-table | error | a view's `out:` writes into a table directory, where the next load reads the artifact back as a row |
| `GD109` | rollup-drift | error | delegated `rollup --check`: a view is drifted or missing |
| `GD110` | validate-issues | error | delegated `validate`: a row breaks its table's schema |
| `GD111` | measured-without-provenance | warn | a table declared `class: measured` whose rows carry none of the provenance columns that store declared |
| `GD113` | rule-compared-nothing | warn | a schema rule that compared **zero rows**, because no row carries the column at all, or the table is empty. It cannot fail, so its pass says nothing. A column that is written-and-blank does **not** fire — see below |
| `GD112` | row-contract-reimplemented | warn | a source file that looks like a hand-rolled copy of `isRowFile` instead of importing it. **A heuristic** — see below |

## Severity policy — `data/_gitdata.yml`

```yaml
engine: ">=0.3.0"

checks:
  GD103: { level: off, reason: "generated artifacts live in rollups/ by design" }
  GD004: { level: error }

scan:
  - package.json
  - .github/workflows/*.yml
  - scripts/**/*.sh

tables:
  games: { class: measured, written_by: "bun sdk:extract", provenance: [measured_at] }
  envelopes: { class: authored }

packs:
  feature-management: 0.1.0
```

The file is `_`-prefixed, so `src/load.js` already skips it: it can never be mistaken for a row or
a table. Every key is optional, and a repo with no policy file gets every check at its default.

**Raising a level needs no justification. Lowering one does.** A check nobody has to explain away
is a check that quietly stops mattering, and the whole reason a silenced check is worse than a
missing one is that it stops anybody looking. So `warn` and `off` both require a `reason:` string;
without one the entry is a `GD000` finding **and does not take effect** — the check keeps its
default level, which is the safe direction when the cause is a typo.

Every lowered check is reprinted in a trailing **silenced by policy** block, with its reason and
how many findings it produced, so a deliberate divergence stays visible and attributed:

```
  silenced by policy:
    GD103  error → off   2 finding(s)    generated artifacts live in rollups/ by design
```

`off` still runs the check. It just cannot fail a build — which is what makes the reason worth
requiring.

## What is not checked says so

A check that could not run is never reported as passing. It appears under **not checked** with the
gap named:

```
  not checked:
    GD004  --offline — the registry was not contacted
    GD005  no pack receipt — nothing records which packs are installed yet
```

That matters most for `GD005`. `requires:` has been declared in every `pack.yml` since packs
existed and read by nothing; this is the check that gives it teeth, but it needs to know **which**
packs are installed and at what version, and nothing records that yet — `init` copies a pack's
files and writes no receipt. So GD005 **skips cleanly**. The receipt it reads today is the `packs:`
key above; when `init` starts writing one, GD005 reads it unchanged.

`GD111` skips the same way, and deliberately does not fail open: a table with no declared `class:`
is reported as unchecked, never as passing.

## The three classes

A table is **authored** (written by hand), **measured** (machine-extracted, and rewritten wholesale
on the next run), or **derived** (rollup output, never rows at all). Only the store knows which,
so the store declares it in `tables:`.

`class: measured` is the expression of a real hazard: a hand-authored row in a table an extract
script owns is destroyed on the next run, with no error. Before `class:` there was nothing in the
tool that could say so, and the workaround was a shouted warning at the top of a `_template.md`.

**Which columns count as provenance is your vocabulary, so you name them.** The engine checks that
the columns you declared carry a value; it never learns what one is called. That is
[ARCHITECTURE](ARCHITECTURE.md) rule 1, and it is why `provenance:` is a list you write rather than
a convention gitdata guesses. A `measured` table that declares no `provenance:` columns is itself a
GD111 finding — nothing then distinguishes a machine-written row from a hand-written one.

## GD103 extends the `_` convention; it does not invent a path law

The tempting rule is "derived artifacts never land inside `data/`". It is wrong, and it is
stronger than the defect requires: this project's own bundled pack writes
`out: data/_views/features-board.md`, and that is correct.

The actual footgun is narrower. `data/features/board.md` has a `.md` extension, sits under a table,
and satisfies `isRowFile()` — so `load()` reads the generated artifact back as a **row of that
table** on the next run. Silently. The `_` prefix is what already prevents this, everywhere in the
system, because the loader skips `_`-prefixed entries.

So GD103 checks the invariant the loader already guarantees rather than a parallel rule nobody
adopted: **anywhere under `data/` that is not `_`-prefixed is rows.** Put artifacts under
`data/_views/`, or outside `data/` entirely — both pass.

## Where GD001 and GD003 look — and how to change it

By default they read the places an invocation actually **executes**:

| | |
| --- | --- |
| `package.json` | every value under `scripts` |
| `.github/workflows/*.yml` and `*.yaml` | parsed as YAML, walked for `run:` values — a package name in a comment or a `uses:` line is not an invocation |
| `**/*.sh` | read whole |

Deliberately **not** every source file. That scan hits package names in prose, in test fixtures,
and in the very documentation that tells people how to pin — and a check that cries wolf is a check
people learn to skip.

An unusual repo widens it, or narrows it, on purpose:

```yaml
scan:
  - package.json
  - .github/workflows/*.yml
  - tools/**/*.sh
  - Makefile
```

`scan:` **replaces** the defaults rather than adding to them, so the effective list is always
exactly what your file says. `**` crosses directory separators, `*` does not; `node_modules`,
`.git`, `dist`, `build`, `coverage` and `vendor` are never walked.

## GD112 is a heuristic, and says so

`isRowFile` is exported because a consumer that writes into `data/` has to answer the same question
the loader answers, and a hand-rolled copy is free to drift. A copy missing one clause either
deletes a file the loader protects or leaves behind one it reads — silently, on both sides. That is
not hypothetical: a copy missing a clause is one of the defects that motivated this whole command.

GD112 is a **fuzzy text scan**. It flags a source file where three things appear together — a `.md`
extension test, an `_`-prefix exclusion, and a README exclusion — because that conjunction is what
makes a path test a *row* predicate. It exempts the file that exports `isRowFile`, and any file that
imports it from `@marktiderman/gitdata`.

It is `warn`, on purpose, and its message says it is a heuristic. The narrower design — look only at
files that already import this package — was considered and **rejected**: the script that motivated
the check reimplements the predicate and never imports gitdata at all, because it shells out to a
runner. A check that structurally cannot see the case it was built for is theatre; a warning that
occasionally over-fires is recoverable. If it is wrong about your file, lower it **with a reason**
and the divergence is on the record.

## Multiple stores

A **store** is a directory holding a `data/` trellis. A repo may have several; `gitdata stores`
lists them all with their tables, row counts, and each table's declared class.

```bash
gitdata stores            # master table of contents
gitdata stores --json
```

There is **one** config file, not two. A store manifest and a policy file would both answer "what
does gitdata know about this store", and both would carry `engine:` — two documents that overlap is
the defect where nobody can tell which one wins. So the manifest and the policy are the same file,
`data/_gitdata.yml`, sitting inside a namespace gitdata already owns rather than at the store root
where a reserved filename would compete with your own.

Discovery does not require that file. A store that has never adopted one is still listed; its
manifest reads absent and anything only the manifest can say — a table's `class` — prints
`UNKNOWN` rather than blank.

`doctor` is single-store: `--root <dir>` points at one store, and the repo-scoped checks (GD001 to
GD006) read that directory's `package.json` and `.github/workflows/`. Run it once per store.

## A warning `doctor` does not check

`gitdata emit codeowners` **replaces the entire output file** — it does not merge, and it does not
append ([`src/emit-codeowners.js:138`](../src/emit-codeowners.js)). A repo whose `.github/CODEOWNERS`
holds hand-authored rules loses every one of them the first time that command runs. Emit to a
different path with `--out` and merge deliberately, or do not adopt the command. No check here
implies it is safe to run.

## Wiring it

```yaml
- run: npx @marktiderman/gitdata@0.2.0 doctor --check
```

Pin the version. That is GD001, and it is the first thing `doctor` will tell you about itself.
