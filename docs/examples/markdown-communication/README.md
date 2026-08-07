---
id: md-comms-index
title: Markdown as a communication medium
kind: index
status: draft
owner: mark.tiderman
tags: [examples, wireframes, diagrams, matrices]
---

# Markdown as a communication medium

Every example in this folder is a plain `.md` file with **zero tooling** — no image exports, no
Figma links that rot, no binary blobs to diff. That is the GitDATA law applied to communication:
the diagram *is* the source, it lives in git, and a PR diff shows exactly what changed.

The mermaid blocks render when *viewing* a committed file on GitHub and in Obsidian. Both bundle
their own mermaid version, so support tracks their build, not the latest upstream release — and
GitHub's web **editor** shows no live preview while you type, only after you commit. Everything
non-mermaid here (frontmatter, tables, ASCII wireframes) is renderer-independent by construction.

Each file carries structured frontmatter, so this folder is also a demo of docs-as-data: an
agent can grep the `kind:` field and know what it is looking at before reading a single line
of prose.

## Which tool for which job

| You want to communicate…            | Reach for                          | Example                                        |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------- |
| What a screen looks like            | ASCII wireframe in a code fence    | [01-wireframes.md](01-wireframes.md)           |
| How data is shaped and related      | Mermaid `erDiagram` + dictionary   | [02-database-design.md](02-database-design.md) |
| A decision, ownership, or coverage  | Markdown tables as matrices        | [03-matrices.md](03-matrices.md)               |
| How a process moves / who calls who | `flowchart` / `sequenceDiagram`    | [04-flows-and-sequences.md](04-flows-and-sequences.md) |
| Lifecycles, journeys, and time      | `stateDiagram` / `journey` / `gantt` | [05-states-journeys-time.md](05-states-journeys-time.md) |
| A fuzzy idea, made sharp            | `mindmap` / `quadrantChart` / one-pager | [06-ideas-and-pitches.md](06-ideas-and-pitches.md) |

## The agent gallery

Three agents were each given a persona, a two-minute budget, and the same brief — communicate
with structure, not prose — and designed their own examples independently:

| Agent             | Persona's bet                                        | File                                              |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------- |
| The Storyteller   | A feature pitch can be *narrated* through diagrams   | [agents/storyteller.md](agents/storyteller.md)    |
| The Systems Mapper| One system, three altitudes, one claim per diagram   | [agents/systems-mapper.md](agents/systems-mapper.md) |
| The Data Artist   | A dashboard can live entirely in plain text          | [agents/data-artist.md](agents/data-artist.md)    |

## The three rules these examples follow

1. **The artifact is text.** If it can't be reviewed in a PR diff, it doesn't belong here.
2. **Structure before prose.** Frontmatter states what the doc is; tables state facts;
   diagrams state relationships; prose only carries what structure can't.
3. **One diagram, one claim.** A diagram that tries to say everything says nothing. Split it.

## What renders where

| Technique              | GitHub | Obsidian | VS Code preview | Plain terminal |
| ---------------------- | :----: | :------: | :-------------: | :------------: |
| Tables / frontmatter   |   ✅   |    ✅    |       ✅        |   ✅ (as text) |
| ASCII wireframes       |   ✅   |    ✅    |       ✅        |       ✅       |
| Mermaid — stable types |   ✅   |    ✅    |   ✅ (plugin)   | ❌ (readable source) |
| Mermaid — `mindmap`, `timeline` | ⚠️ ¹ | ⚠️ ¹ |     ⚠️ ¹       | ❌ (readable source) |

¹ Both are marked **experimental** upstream. In each case the core syntax is stable and only the
icon integration is the experimental part — but the classification is theirs, not ours, so we
inherit it. Both also arrived only in Obsidian 1.4's mermaid 10 bundle. Older viewers show the
fence as a code block rather than a picture — which is the graceful part: nothing is lost, it
just isn't drawn. The two used here are `mindmap` (in
[06-ideas-and-pitches.md](06-ideas-and-pitches.md)) and `timeline` (in
[05-states-journeys-time.md](05-states-journeys-time.md)).

That last column is the reason the ❌ doesn't worry us. Mermaid source reads like an outline, so
an agent grepping at speed still extracts every relationship without rendering anything.

**Verified, not assumed:** all 14 mermaid blocks in this folder were rendered locally with
`@mermaid-js/mermaid-cli` (mermaid 11) before this was committed — 14/14 produced SVG. That
proves the *syntax* is valid; it does not prove any particular viewer's bundled version will
draw it, which is exactly what the ⚠️ row above is for.
