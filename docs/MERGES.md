# Derived views and merge conflicts

**The rows are what merge. The view is a render of them.** Every rule in this document is that
sentence applied somewhere.

## The shape of the failure

A rolled-up view aggregates many rows into one rendered file — a board, a digest, a tree. That
makes it a file **almost every branch touches**: any change to any row it reads changes its bytes.

Put `rollup --check` in front of PRs as a required check, and every PR must commit a fresh render
to go green. Now run two PRs at once:

1. PR A edits row X, regenerates the view, and merges. The view on the integration branch changes.
2. PR B edited row Y and regenerated the *same* view from a base that did not have A's rows.
3. B's render and the branch's render disagree line-by-line across one aggregated file. Text merge
   has no way to combine two renders — **conflict**, on a file neither author hand-wrote.

One writer per render is fine; N concurrent writers of one aggregated artifact is a conflict
engine. The failure is structural, so the fix is too. It is not a cleverer merge tool, and it is
never resolving the conflict by hand.

## Resolving one, today

A conflicted view — or a committed view carrying `<<<<<<<` markers, which `rollup --check` calls
out by name — has a mechanical resolution, always the same:

```bash
# from inside the conflicted merge/rebase:
git checkout --theirs -- data/_views    # or --ours; it does not matter — see below
gitdata rollup                          # re-render from the rows that actually merged
git add data/_views
# continue the merge
```

It does not matter which side you take first because neither side is correct: the only correct
content is a fresh render of the **merged rows**, and `gitdata rollup` overwrites the file
wholesale — conflict markers and all. Hand-merging the render, however carefully, produces bytes
the next `--check` will reject, because no render of any row set ever contained them.

## Preventing it: the single-writer pattern

Make the integration branch the only writer of rendered views:

- **PRs carry rows only.** A feature branch edits rows (and view *specs* — `*.view.yml` is
  authored, not rendered) and never commits the rendered `.md`.
- **One workflow regenerates on the integration branch.** On every push to `main` (and any other
  long-lived branch you integrate on), it re-runs the rollup, commits the delta under the view
  directories, and pushes. Serial by construction, so it conflicts with nothing.
- **The PR-side gate changes meaning.** `rollup --check` compares committed bytes against the
  current rows, which on a rows-only PR is stale *by design* — so it stops being the PR gate.
  What a PR must prove instead:
  - `gitdata validate` — the rows obey their schemas (unchanged);
  - `gitdata rollup` **exits zero** — the views still *compile*, so a broken spec or query fails
    before merge, not on the integration branch after (discard the workspace render; commit
    nothing);
  - a **guard** — the PR changes no rendered `.md` under a view directory, relative to its base.
    Rendered bytes in a PR are the conflict being reintroduced.
- **`--check` moves to where the writer writes.** Run it on the integration branch — after the
  refresh workflow, where it must always pass — and in any audit of that branch. It remains the
  driftproof guarantee; it just stops being asked a question it can no longer answer ("do this
  PR's inherited views match rows it did not write?").

Once no PR modifies a rendered view, no two PRs can conflict on one.

Scaffold the whole thing:

```bash
gitdata emit refresh                                      # main only, npx, data/_views
gitdata emit refresh --branch main --branch "release/**" \
  --run "npm run views:regenerate" --views data/_views    # or shaped to your repo
```

It writes `.github/workflows/gitdata-refresh.yml` with both halves — the refresh job (push) and
the guard job (pull_request) — commented for adaptation. **The file is yours once written**:
unlike `emit codeowners` output it is a scaffold, not a derived artifact, so gitdata never
overwrites it and nothing drift-checks it. There is no `--check` for it, deliberately.

## What it costs, stated plainly

- **Views on a feature branch are stale by that branch's own edits.** The render catches up at
  merge. If a view is a *contract* other work on the branch must read mid-flight, that store may
  be the wrong candidate for single-writer — this pattern fits stores whose views are reports
  read at the integration branch, and whose rows change in most PRs.
- **Two long-lived branches can still conflict with each other** when one merges into the other —
  each had its own writer. That merge is serial and rare, and the resolution is the mechanical
  one above, never a hand-merge.
- **A protected integration branch must let the workflow push.** If your ruleset refuses the bot,
  drop that branch from the workflow and let its views ride the serial, reviewed PRs that reach
  it — with the same mechanical resolution when they conflict.

## Enforcement, per the law

gitdata guides; GitHub enforces. The guard job **fails**; whether that blocks is your branch
protection's decision. The refresh job **pushes**; whether your ruleset admits it is yours too.
Nothing in this document is a severity opinion.
