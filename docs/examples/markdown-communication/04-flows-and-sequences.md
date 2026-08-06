---
id: md-comms-flows
title: Flows and sequences — process and protocol
kind: flow
status: draft
owner: mark.tiderman
tags: [examples, flowchart, sequence]
---

# Flows and sequences — process and protocol

Two different questions, two different diagrams. A **flowchart** answers *"what happens
next?"* — one actor's decisions through time. A **sequence diagram** answers *"who talks to
whom?"* — many actors, message by message. Using one where the other belongs is the most
common diagram mistake in PRs.

## Flowchart: what happens when a student joins a race

```mermaid
flowchart TD
    A[Student taps JOIN] --> B{Session state?}
    B -->|lobby| C[Add to lobby roster]
    B -->|live| D{Late-join allowed?}
    B -->|finished| E[Show results screen]
    D -->|yes| F[Spawn at back of pack]
    D -->|no| E
    C --> G{2+ students online?}
    G -->|yes| H[Enable teacher's Start button]
    G -->|no| I[Wait — show 'inviting…' state]
    F --> J[Race HUD]
    H --> J
```

One decision per diamond, one verb per box. If a box needs a comma, it's two boxes.

## Sequence: the auth handoff (app shell → game runtime)

```mermaid
sequenceDiagram
    participant RN as App shell (RN)
    participant API as API
    participant U as Game runtime (Unity)

    RN->>API: POST /auth/login
    API-->>RN: session token + profile
    RN->>U: SET_SESSION {token, profile}
    Note over U: No ACK by design —<br/>the seam fails silently
    U->>API: GET /session/validate
    API-->>U: 200 OK
    U-->>RN: SESSION_READY
    Note over RN,U: Only now is the handoff proven —<br/>SENT is not RECEIVED
```

The two `Note` boxes carry the entire reason this diagram exists: the danger lives in the
gaps between arrows, and prose *inside* the diagram is the only place readers will see it.

## The rule of the missing arrow

The most valuable thing a sequence diagram can show is the arrow that **isn't there**. Here,
there is no `U-->>RN: ACK` after `SET_SESSION` — that absence is a design fact, and drawing
the diagram is how it gets noticed in review. A wall of prose would bury it; six arrows
expose it.
