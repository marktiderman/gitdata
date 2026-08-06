---
id: md-comms-states-time
title: States, journeys, and time
kind: lifecycle
status: draft
owner: mark.tiderman
tags: [examples, state-machine, journey, gantt, timeline]
---

# States, journeys, and time

Three lenses on the same underlying thing — change over time — at three altitudes:
the **machine's** view (states), the **human's** view (journey), and the **project's** view
(plan and history).

## The machine: game session lifecycle

```mermaid
stateDiagram-v2
    [*] --> Lobby
    Lobby --> Live : teacher starts (2+ online)
    Lobby --> Cancelled : teacher exits
    Live --> Finished : all finish or timer ends
    Live --> Paused : teacher pauses
    Paused --> Live : resume
    Paused --> Cancelled : abandoned 10 min
    Finished --> [*]
    Cancelled --> [*]

    note right of Finished
        Scores written exactly once here.
        No business transition leaves Finished
        (only termination) — results are immutable.
    end note
```

A state diagram is a contract: every arrow is a *permitted* transition, and everything not
drawn is *forbidden*. That second half is the valuable half — write it in the caption.

## The human: a student's first five minutes

```mermaid
journey
    title First-run experience, student on mobile
    section Getting in
      Download and open app: 3: Student
      Enter class code: 4: Student
      See own name appear on teacher screen: 7: Student
    section First race
      Wait in lobby: 3: Student
      Race starts, controls unexplained: 2: Student
      Finish race, see rank and confetti: 7: Student
```

The scores (1–7) are the point: two valleys — the lobby wait and the unexplained controls —
are now visible, ranked, and arguable. A journey diagram is a prioritization tool wearing a
UX costume.

## The project: plan forward, history backward

```mermaid
gantt
    title Rollout: markdown communication toolkit
    dateFormat YYYY-MM-DD
    section Examples
      Author core examples      :done, a1, 2026-08-03, 3d
      Agent-designed examples   :active, a2, 2026-08-06, 1d
    section Adoption
      Team review               :a3, after a2, 3d
      Schema for doc frontmatter:a4, after a3, 4d
      Rollup wired to --check   :a5, after a4, 3d
```

```mermaid
timeline
    title How we got here
    2026-05 : Docs scattered across tools : Screenshots rot in Slack
    2026-06 : GitDATA north star written
    2026-07 : Engine ships v0.2 : Views validated on real specimens
    2026-08 : Diagrams move into markdown : This folder
```

Gantt looks forward and invites correction ("review won't take 3 days"); timeline looks
backward and builds shared memory. Same axis, opposite jobs — don't merge them.
