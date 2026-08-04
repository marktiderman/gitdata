# GitDATA — agent instructions

**Dependable, structured, organized docs as data in git that agents and owners can trust.**

The purpose, plainly: a system to track our docs as data.

---

## The north star (canonical — operator-authored, reproduce verbatim)

> GitDATA - Dependable, structured, organized docs as data in git that agents and owners can trust.
>
> 1. SSOT - ensure a single source of truth so agents can trust they are looking at the correct version especially when they are grepping with speed and running quickly down the critical context path
> 2. organized content. - where files should live. (anyting within the gitdata system (ie the /data/ folder structure) must follow these rules)
> 3. structured metadata - what each file should containt. critical structured content must exist as frontmatter.
> 4. folder scheme exists
> 5. permissions - who is allowed to make changes. (leverage the best of github out of the box features for this,  ie based on folders we can declare code owners. Github PRs require approval for certain files to be
> 6. driftproof - rollups create the current state based on metadata, folder structure.
> 7. Flexible.  can be extended and used for any purpose that needs dependable structured context

**This block is edited only by the operator.** Typos and the truncated #5 are intentional — it is
the operator's own statement of intent, not a draft to clean up.

## The law

**GitDATA guides. GitHub enforces.**

GitDATA declares, validates, reports, and emits GitHub config. **It never blocks.** Every design
question resolves against this line:

- Tempted to add roles, actors, approval workflows, or runtime interception? That is enforcement.
  It belongs in GitHub, not here.
- `--check` exits non-zero so the *consumer* can mark it a required check. We ship no opinion about
  severity.

## Rules for working in this repo

1. **The engine stays ignorant of any domain.** It knows filter/sort/join/tree/count/render. It must
   never learn what a "feature" is or what `ratified` means. Domain knowledge lives in the
   consumer's schemas and views.
2. **Core ships zero tables.** Table definitions travel as installable packs, never baked in.
3. **Do not invent a query language.** SQL is the query layer. If a view cannot be expressed, use
   the `compile:` escape hatch — do not grow the template syntax.
4. **Determinism is the product.** No timestamps, no randomness, no directory-order reliance.
   Byte-identical output given identical sources is what makes drift checking possible. Rows are
   sorted by filename at load; anything non-deterministic is a bug.
5. **The format does not move.** Frontmatter markdown stays editable by hand, in the GitHub web UI,
   and in Obsidian, with no adapter. Never adopt a format trick that breaks plain-file editing.
6. **Prove it on real specimens.** Views are validated byte-for-byte against real committed
   artifacts, not fixtures alone.

## Layout

```
src/frontmatter.js       parse ---frontmatter--- + body
src/load.js              walk data/, folder → table, file → row
src/project.js           rows → in-memory SQLite; registers collapse_ws(), md_section(), natural_key()
src/render.js            {{name}} / {{name.column}} template substitution
src/rollup.js            read views → compile → write or --check; the compile: escape hatch
src/validate.js          read data/_schema/*.schema.yml → check loaded rows; required/unique/enum/pattern/ref
src/shapes/              sections/digest/tree declarations → SQL (index.js dispatches, sql.js builds)
src/init.js              scaffold data/ — bare, or from a pack
src/emit-codeowners.js   data/<table>/_owners.yml → .github/CODEOWNERS; write or --check
src/cli.js               the CLI
src/index.js             the programmatic API — what the package exports is the contract
test/engine.test.js      self-contained fixture repo in a temp dir
test/regressions.test.js pinned defects — each test names the failure it prevents
test/cli.test.js         spawned-process CLI contract + the pack quickstart end to end
test/shapes.test.js      shape declarations → expected lines
test/boundaries.test.js  guards the laws above (manifest, exports, forbidden names)
```

## Testing

```bash
npm test
```

Tests must not require any other repo to be checked out. Integration against a real corpus is run
separately and explicitly.
