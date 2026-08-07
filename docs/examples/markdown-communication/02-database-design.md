---
id: md-comms-db-design
title: Database design as diagram + dictionary
kind: schema
status: draft
owner: mark.tiderman
entities: [classroom, student, enrollment, game_session, score]
tags: [examples, database, erd]
---

# Database design as diagram + dictionary

A schema needs two views: the **shape** (an ER diagram — relationships at a glance) and the
**contract** (a data dictionary — the field-level truth). Mermaid gives you the first; a table
gives you the second; both diff cleanly.

## The shape

```mermaid
erDiagram
    CLASSROOM ||--o{ ENROLLMENT : has
    STUDENT   ||--o{ ENROLLMENT : joins
    CLASSROOM ||--o{ GAME_SESSION : hosts
    GAME_SESSION ||--o{ SCORE : records
    STUDENT   ||--o{ SCORE : earns

    CLASSROOM {
        string id PK
        string name
        string join_code UK "6-char, rotates on demand"
        string teacher_id FK
    }
    STUDENT {
        string id PK
        string display_name
        int    streak_days
    }
    ENROLLMENT {
        string classroom_id PK, FK
        string student_id PK, FK
        string status "active | removed"
    }
    GAME_SESSION {
        string id PK
        string classroom_id FK
        string game_id "e.g. track-racing"
        string state "lobby | live | finished"
    }
    SCORE {
        string session_id PK, FK
        string student_id PK, FK
        int    points
        int    rank "computed at session finish"
    }
```

## The contract

Only the fields where the diagram can't carry the nuance:

| Entity.field            | Type   | Rules                                                        |
| ----------------------- | ------ | ------------------------------------------------------------ |
| `CLASSROOM.join_code`   | string | Unique while active; rotating it orphans no enrollments      |
| `ENROLLMENT.status`     | enum   | `removed` keeps the row — history is never deleted           |
| `GAME_SESSION.state`    | enum   | Only legal walk: `lobby → live → finished`; no state skips   |
| `SCORE.rank`            | int    | Derived. Written once at `finished`; never recomputed after  |

## The drift-proof move

The diagram above will rot the day someone adds a column and forgets this file. The GitDATA
answer: make each entity a frontmattered file under `data/entities/`, declare the rules in
`data/_schema/`, and **generate** this document as a rollup. Then `--check` fails the PR when
diagram and truth disagree — the doc stops being a promise and becomes a build artifact.

That is the difference between *documenting* a schema and *tracking it as data*.
