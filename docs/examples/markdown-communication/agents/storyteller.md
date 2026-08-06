---
id: story-streak-garden
title: "Streak Garden: the story of a feature"
kind: story
author: agent-storyteller
tags: [gamification, retention, mobile, narrative, example]
---

# Streak Garden

*A product idea told as a story — the prose is thin on purpose. The structure carries it.*

## The problem

Maya, age 11, did her math quizzes nine days in a row. On day ten her family went camping.
Her streak counter — a cold orange number — reset to zero. She never opened the app with the
same enthusiasm again. Streak numbers punish; they don't grow anything. What if a streak
wasn't a number you could lose, but a garden you could tend?

**Streak Garden:** every day of practice waters a plant. Miss a day and the plant wilts —
but it doesn't die. Come back and revive it. Long-term care grows rare species. Your garden
*is* your history, and history can't be reset.

## Maya's week

```mermaid
journey
    title A week in the Streak Garden
    section Monday
      Finishes a quiz: 5: Maya
      Waters her sprout: 5: Maya
    section Wednesday
      Sprout becomes a fern: 5: Maya
      Shows a friend: 4: Maya
    section Weekend camping
      Misses two days: 3: Maya
      Fern wilts, does not die: 3: Maya
    section Monday again
      Opens app nervously: 3: Maya
      Revives the fern with one quiz: 5: Maya
      Rare seed unlocked: 5: Maya
```

The emotional floor never drops to 1. That's the whole design.

## The moment of use

What Maya sees when she returns after the camping trip:

```text
+----------------------------------+
|  YOUR GARDEN            [day 12] |
|                                  |
|   .--.        \|/        _       |
|  ( 🌷 )      --🥀--     (🌱)     |
|   `--'        /|\        --      |
|  tulip     fern needs   new seed |
|  day 12     water!      (rare)   |
|                                  |
|  +----------------------------+  |
|  |  💧 Revive your fern —     |  |
|  |     one quiz brings it back|  |
|  |        [ START QUIZ ]      |  |
|  +----------------------------+  |
+----------------------------------+
```

One wilted plant. One button. No shame, no zero.

## How it works

```mermaid
sequenceDiagram
    participant M as Mobile App
    participant A as API
    participant G as Garden Service
    participant D as MongoDB

    M->>A: POST /quiz/complete {score}
    A->>G: recordPractice(userId, date)
    G->>D: upsert garden_days
    D-->>G: gapDays = 2
    G->>G: wilt(plants, gapDays) — never delete
    G-->>A: {garden, revived: ["fern"], unlocked: ["rare_seed"]}
    A-->>M: garden state + celebration events
    M->>M: play revive animation
```

The key rule lives in one place: `wilt()` degrades state, nothing ever deletes it.

## What we'd measure

| Metric | Today (streak counter) | Target (garden) | Why it matters |
| --- | --- | --- | --- |
| Day-after-lapse return rate | 22% | 45% | The core bet: wilting invites, zero repels |
| 30-day retention | 31% | 40% | Gardens accumulate; counters reset |
| Sessions after first lapse | 1.8/wk | 3.5/wk | Revival becomes a reason to open |
| "Show a friend" shares | — | 5% of DAU | A garden is worth showing; a number isn't |

## The end of the story

Six months in, Maya's garden has a wilted patch from spring break — and she likes it.
It's proof she came back. The feature ships when the sequence diagram above is boring
and the journey diagram above is true.
