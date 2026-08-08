---
kind: idea-record
id: I-002
title: "A gate that checked nothing should not exit 0"
state: open
solves: "`validate` and `rollup --check` both exit 0 over a store with no schemas and no views, so a required CI check stays green while reading nothing. A drift gate that passes because it stopped looking is the exact failure this tool exists to prevent."
raised: "Session 2026-08-07 — carried in from the doctor design (ruling R6) and MEASURED on a scratch store while delivering PR #17."
became: null
verdict: null
tags: [gate, ci, non-vacuity, exit-code]
created: 2026-08-07
---

# A gate that checked nothing should not exit 0

## Why

Measured, not inferred. A scratch store with one row, no `_schema/` and no `_views/`:

```console
$ gitdata validate --root .
  no schemas found — add data/_schema/<table>.schema.yml
validate exit=0

$ gitdata rollup --check --root .
  no views found — add data/_views/<name>.view.yml
rollup --check exit=0
```

Both print the right message. Both **exit 0**.

The message is only read by a human watching a terminal. The exit code is what CI reads, and CI is
where this tool makes its claim: `--check` exits non-zero *so the consumer can mark it a required
check*. A consumer who wires that up, then renames a directory, moves a store, or mistypes a
`--root`, gets a green required check over a store nobody is reading. Nothing warns, because from
the inside "no schemas found" and "all schemas pass" are the same answer: zero failures.

This is the same shape as the 0.2.1 defect — a confident right-looking answer to a question that
was never actually asked.

## The shape

`--check` exits non-zero when it checked nothing. `validate` with no schemas, `rollup --check` with
no views: both become findings rather than passes.

The open question, and the reason this is an idea and not a patch: **it is a breaking change to an
exit code**, which is precisely the contract consumers wire into CI. A consumer who legitimately has
no views yet goes red on upgrade. Options, in order of preference:

1. Non-zero by default, with `--allow-empty` for the bootstrapping case.
2. Behind a flag now, default flipped at the next major.
3. Left to `doctor`, which already reports it as a finding — the status quo since PR #17.

Option 3 is what ships today, and it is the weakest, because it only helps a consumer who runs
`doctor`. The consumers most likely to have a mis-rooted store are the ones least likely to have
adopted a second command.

## Why it fits the laws

Domain-ignorant, no query-language change, no determinism impact, format untouched. The only
tension is with nothing in the laws — it is a compatibility question, not a design one.

## Done when

`validate` and `rollup --check` over an empty store exit non-zero, a test pins each, and the
existing "0 clean / 1 drifted / 1 missing" contract for a NON-empty store is unchanged — proven by
the current exit-code tests still passing untouched.

## One level down — the RULE, inside a full store (shipped as GD113)

The sentence above generalises, and the general form is the more useful one:

> **A comparison that returns the same answer for every possible input is not a check.** Whether
> the constant answer is "pass" or "fail" is an accident of implementation, not a fact about the
> data.

This row is that sentence at the level of a **gate**. The same defect exists at the level of a
**rule**, and a full store hides it better, because the report is not empty — it is full of
correct-looking passes with one meaningless entry among them.

Measured, 2026-08-07, on 45 real task rows in `GamifyEducation/gamify-platform`. Three failures in
one day, all one disease — **a container reached a scalar comparison and gitdata answered anyway**:

| rule | what happened | which constant |
| --- | --- | --- |
| `enum: {tags: [...]}` | `Set(allowed).has(["prd-063","port-hygiene"])` | always FAIL — 44 issues, including the row whose tags were entirely allowed |
| `ref: {envelope: envelopes.id}` | `Set(ids).has([...])` | always FAIL |
| `where: {status: {not: [ready, approved]}}` | `String(list)` → `'ready,approved'`, so `IS NOT` | always PASS — filtered nothing, exited 0, and the board reported 42 for 33 |

The third is the dangerous one and it is the same disease, which is why "cannot fail" is the wrong
framing to build on: two of the three could *only* fail. **Constant** is the property; **vacuous**
is one of its two spellings.

What shipped:

- **The coercion refuses.** `String(list)` produces a *plausible-looking* string, which is why
  three separate readings of the third defect each blamed the wrong branch. Refusal happens where
  the information is lost — one function — rather than in each operator.
- **`validate()` returns `rules`**: every (rule, column) and how many rows it actually compared.
- **`GD113 rule-compared-nothing`**, at `warn`, narrowed so it never fires on a schema written
  ahead of its data.

**This does not close this row.** GD113 needs `doctor` to be run, and I-002's own complaint is that
the consumers most likely to be mis-rooted are the ones least likely to have adopted a second
command. The exit-code question above is still open and still the harder half.
