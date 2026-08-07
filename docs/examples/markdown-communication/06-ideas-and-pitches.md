---
id: md-comms-ideas
title: Ideas and pitches — making the fuzzy sharp
kind: pitch
status: draft
owner: mark.tiderman
tags: [examples, mindmap, quadrant, pitch]
---

# Ideas and pitches — making the fuzzy sharp

Early ideas die two ways: too vague to act on, or formalized so early the good parts get
polished off. These three structures hold an idea at exactly the right firmness.

## Diverge: the mindmap

*Everything the idea could be, before choosing what it will be:*

```mermaid
mindmap
  root((docs as data))
    Wireframes
      ASCII in fences
      Screens as rows
    Schemas
      ER diagrams
      Generated dictionaries
    Reviews
      Diff the diagram
      Matrix per decision
    Agents
      Grep the frontmatter
      Rollups answer questions
      Drift fails the check
```

A mindmap makes no commitments — no arrows, no order, no priority. That's its honesty: it
says "this is the territory," not "this is the plan."

## Converge: the quadrant

*The same ideas, now forced to declare their cost and worth:*

```mermaid
quadrantChart
    title Effort vs impact - toolkit candidates
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Plan carefully
    quadrant-2 Do these first
    quadrant-3 Skip for now
    quadrant-4 Question these
    ASCII wireframes: [0.2, 0.75]
    Mermaid ER diagrams: [0.3, 0.85]
    Decision matrices: [0.25, 0.65]
    Generated rollup docs: [0.75, 0.9]
    Custom diagram DSL: [0.9, 0.3]
```

Placing a dot is a claim someone can dispute in review — which is precisely what a pitch
needs before anyone writes code. (Note the bottom-right resident: building our own diagram
language. The chart says what the law says: don't.)

## Commit: the one-pager

The narrowest structure that still counts as a pitch — every heading is a question, and a
pitch that can't fill a heading isn't ready:

> ### Problem
>
> Diagrams live outside git, so they rot silently and agents can't read them.
>
> ### Proposal
>
> Every diagram is mermaid or ASCII inside a frontmattered `.md`. Nothing binary.
>
> ### What we are NOT doing
>
> No diagram DSL. No rendering pipeline. No Figma migration mandate.
>
> ### First slice
>
> This folder. Cost: one PR. Reversal cost: `git revert`.
>
> ### How we'll know it worked
>
> Next design debate cites a diagram diff instead of a screenshot.

The **NOT doing** section is the highest-value heading in the doc — scope stated as data,
cheap to review, and the first thing readers look for whether you write it or not.
