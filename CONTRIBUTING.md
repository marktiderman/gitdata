# Contributing

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — one page, and it answers most review
comments before they happen.

```bash
npm install
npm test
```

## Which layer?

| I want to… | It goes in |
| --- | --- |
| fix how frontmatter, SQL, rendering or drift-checking behaves | `src/` — must stay vocabulary-free |
| add a reusable way to turn rows into an artifact | `src/shapes/` — must suit a repo you have never seen |
| describe what *my* things are called | a pack, or your own repo |

Writing SQL in a view spec means a shape is missing. Open an issue describing the artifact you
wanted — more useful than the SQL you wrote to get it.

## Adding a shape

A shape is `(db, spec) => string[]`, returning the lines of an artifact.

1. Write `src/shapes/<name>.js`. Take what the rows *are* from `spec`, what they are *called* from
   the consumer. Build SQL with the helpers in `shapes/sql.js` (`where`, `column`, `orderBy`,
   `rowExpr`) — they already handle quoting, null spellings, natural ordering, and tie-breaks.
2. Register it in `src/shapes/index.js` and document it in `SHAPES.md`. Tests enforce that the
   registry, the modules, and that list agree.
3. Handle what looks easy and is not: a heading over zero rows is drift; rows sharing a sort value
   must not depend on insertion order; nothing may be dropped silently. If your shape can fail to
   place a row, say so in the output — see how `tree` reports orphans and cycles.
4. Test the failure it exists to expose, not just the happy path.

## Adding a pack

A folder under `packs/` with a `pack.yml` and a `files/` tree copied verbatim into the consumer's
repo.

```yaml
name: my-pack          # must equal the folder name
version: 0.1.0         # semver, independent of the engine
requires: ">=0.1.0"    # engine range this works against
title: Human name
description: >
  What table(s) this creates and what artifact it generates.
tables: [things]       # folders that get a .gitkeep so the trellis survives a clone
installs:              # what lands, for the reader; the copy walks files/ regardless
  - data/things/_template.md
  - data/_views/things-board.view.yml
```

- **Name it for the job, not for your company or project.** A pack teaches by example.
- **No vocabulary that only makes sense inside one organisation** — numbering schemes, internal
  status ladders, coordinate systems. What is left after stripping them is the useful part.
- **Prefer shapes over SQL**, so the pack doubles as a worked example.

## Tests

`node --test`, no framework. Each test builds its own fixture repo in a temp dir, so the package is
testable without any consumer checked out beside it.

`test/boundaries.test.js` enforces the layer rules and keeps the docs honest. When it fails, the
fix is almost never to widen the test.

## Style

- Comments explain **why**: the constraint, the defect that motivated the code, the thing the next
  reader would otherwise simplify back into a bug.
- Errors name the file, the field, and what was expected.
- No new dependencies without a reason in the PR description.

## Cutting a release

**Bump `version` in `package.json`, merge to `main`, and that is the whole process.**
`.github/workflows/release-on-merge.yml` notices the change, runs the suite, tags `v<version>`, and
publishes over OIDC trusted publishing. There is no NPM_TOKEN in this repo and there should never
be one — npm mints a short-lived token from this repository's own identity.

- **Do not run `npm version patch`** once the bump is merged. It would bump *again* and skip the
  version you meant to ship.
- **A merged bump with no release is silent.** That is what the workflow exists to stop: `0.2.1`
  and `0.3.0` both merged before it existed, neither was tagged, and npm went on serving `0.2.0`
  with nothing reporting the gap.
- **Publishing is irreversible.** npm versions are immutable; a wrong publish can be deprecated,
  never replaced.

`.github/workflows/release.yml` still publishes from a hand-pushed `v*` tag. That is the manual
override — for a re-release, or to cut a version from a commit that is not `main`'s head.

Which number: **patch** for a fix, **minor** for a new command or a new dependency. `0.2.1` for the
`where:` fix and `0.3.0` for `doctor` + `stores` are the worked examples.
