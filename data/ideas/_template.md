---
# Copy this file to data/ideas/<id>--<slug>.md and edit.
# Underscore-prefixed files are never treated as rows, so this template is safe to keep.

kind: idea-record
id: I-000 # immutable for life — never renamed, renumbered, or reused
title: "A short, plain name for the idea" # QUOTE IT if it contains ` #` — YAML reads that as a
# comment and silently truncates the value.
state: open # open | became | declined
solves: "the problem it removes, OR what it would let us stop doing" # REQUIRED. If you cannot
# answer either, this is a preference, not an idea — and preferences do not get rows.
raised: "where this came from — a session, an issue, a PR, a person" # REQUIRED. An idea with no
# provenance cannot be re-argued, because nobody can find what was already said about it.
became: null # an issue or PR reference (e.g. "#16") when `state: became`
verdict: null # one sentence, when `state: declined`. What answered it, and where.
tags: []
created: 2026-01-01
---

# A short, plain name for the idea

## Why

The problem, stated so someone who has not met it can recognise it. If there is a defect that
motivated this, describe the defect — a reproduction beats an assertion.

## The shape

What you would actually build, in enough detail to argue with. Not a design doc; the sketch that
lets a reader say "no, because…".

## Why it fits the laws

The four in CLAUDE.md that constrain every change here: the engine stays domain-ignorant, no new
query language, determinism is preserved, the format stays hand-editable. An idea that breaks one
of them is not automatically wrong, but it must say so out loud rather than hope nobody checks.

## Done when

What would have to be true. If you cannot write it, say so — an idea that cannot be falsified is
worth recording and worth marking as vague.
