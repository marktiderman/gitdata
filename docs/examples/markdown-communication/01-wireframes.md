---
id: md-comms-wireframes
title: Wireframing views in plain markdown
kind: wireframe
status: draft
owner: mark.tiderman
screens: [teacher-dashboard, student-mobile-home]
tags: [examples, wireframes, ui]
---

# Wireframing views in plain markdown

An ASCII wireframe in a code fence is the fastest lo-fi mockup that survives a PR review. It
diffs line-by-line, it renders identically everywhere, and nobody argues about pixel colors —
which is the point of lo-fi.

## Teacher dashboard — class overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◤ Gamify   Classes ▾   Reports   Library              🔔  (MT) ▾    │ ← ①
├──────────────┬───────────────────────────────────────────────────────┤
│              │  Period 3 — Earth Science           [ Start Race ▶ ]  │ ← ②
│  MY CLASSES  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐      │
│              │  │ 24 students │ │ 87% streak  │ │ 3 games     │      │ ← ③
│  ● Period 3  │  │ online now  │ │ this week   │ │ assigned    │      │
│  ○ Period 4  │  └─────────────┘ └─────────────┘ └─────────────┘      │
│  ○ Period 6  │                                                       │
│              │  LEADERBOARD                        ASSIGNMENTS       │
│  + New class │  ┌───────────────────────────┐  ┌──────────────────┐  │
│              │  │ 1. 🥇 ava.r      2,410 xp │  │ ▣ Quiz: Plate    │  │
│              │  │ 2. 🥈 jordan.k   2,180 xp │  │   Tectonics      │  │
│              │  │ 3. 🥉 sam.w      2,015 xp │  │   due Fri ──────▶│  │ ← ④
│              │  │ …                  ⌄ more │  │ ▢ Race: Volcano  │  │
│              │  └───────────────────────────┘  │   Rally (draft)  │  │
│              │                                 └──────────────────┘  │
└──────────────┴───────────────────────────────────────────────────────┘
```

| # | Region        | Behavior                                                          |
| - | ------------- | ----------------------------------------------------------------- |
| ① | Top nav       | Class switcher is a dropdown; avatar menu holds settings + logout |
| ② | Primary CTA   | `Start Race` is disabled until ≥2 students are online             |
| ③ | Stat tiles    | Live via websocket; degrade to last-known value with a ⚠ badge    |
| ④ | Assignment row| Arrow affordance opens the grading drawer, not a new page         |

## Student mobile — home screen

Two states, side by side, because the empty state *is* the design problem:

```
   FIRST RUN (no class joined)             NORMAL (joined, race live)
┌─────────────────────────┐            ┌─────────────────────────┐
│      ⛰  Gamify          │            │  Hi Ava!          🔥 12 │
│                         │            ├─────────────────────────┤
│   Your class awaits.    │            │  ┌───────────────────┐  │
│                         │            │  │ 🏁 VOLCANO RALLY  │  │
│  ┌───────────────────┐  │            │  │   LIVE — 18 in    │  │
│  │  Enter class code │  │            │  │   [ JOIN NOW ]    │  │
│  │  [ _ _ _ - _ _ _ ]│  │            │  └───────────────────┘  │
│  └───────────────────┘  │            │  Up next                │
│                         │            │  ▸ Quiz: Plate Tectonics│
│         ( Join )        │            │  ▸ Practice: Match-3    │
│                         │            ├─────────────────────────┤
│  or scan teacher's QR   │            │  🏠     🏆     👤       │
└─────────────────────────┘            └─────────────────────────┘
```

## Why this beats a screenshot in a repo

- **Reviewable:** moving the CTA is a one-line diff, not "compare these two PNGs."
- **Greppable:** an agent hunting for where `Start Race` appears finds this file.
- **Honest fidelity:** boxes can't pretend to be a finished design, so feedback stays on
  structure — the only thing a wireframe should be judged on.
- **Data, not just picture:** the frontmatter `screens:` list makes wireframes enumerable.
  A rollup can answer "which screens have wireframes?" without parsing ASCII art.
