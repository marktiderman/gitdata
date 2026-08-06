---
id: md-comms-matrices
title: Matrices — decisions, ownership, coverage, risk
kind: matrix
status: draft
owner: mark.tiderman
tags: [examples, matrix, decision, raci, coverage]
---

# Matrices — decisions, ownership, coverage, risk

A matrix is the highest-density structure markdown has. Four workhorse shapes:

## 1. Decision matrix (weighted)

*Choosing where diagrams live. Scores 1–5, weight in the header.*

| Criterion (weight)      | Mermaid in .md | Figma links | Draw.io PNGs |
| ----------------------- | :------------: | :---------: | :----------: |
| Diffs in a PR (×3)      |     5 → 15     |   1 → 3     |    1 → 3     |
| Zero tooling (×2)       |     5 → 10     |   2 → 4     |    3 → 6     |
| Visual fidelity (×1)    |     3 → 3      |   5 → 5     |    4 → 4     |
| Agent-greppable (×3)    |     5 → 15     |   1 → 3     |    1 → 3     |
| **Total**               |    **43** ✅   |   **15**    |   **16**     |

The weights are the argument. Put them in the doc and the debate moves from "I prefer X" to
"you weighted diffability too high" — which is a debate you can actually settle.

## 2. RACI (ownership)

| Activity                  | Operator | Agent | Reviewer | GitHub |
| ------------------------- | :------: | :---: | :------: | :----: |
| Edit the north star       |  **R/A** |   —   |    —     |   —    |
| Draft views & schemas     |    C     | **R** |    I     |   —    |
| Approve schema changes    |  **A**   |   —   |    R     |   —    |
| Enforce required checks   |    —     |   —   |    —     | **R**  |

One letter per cell, one **A** per row. The last row is the GitDATA law in matrix form:
enforcement is GitHub's job, nobody else's.

## 3. Coverage matrix (the honest checklist)

*Which communication technique has a proven example in this folder:*

| Technique         | Example written | Renders on GitHub | Frontmattered | Rollup-ready |
| ----------------- | :-------------: | :---------------: | :-----------: | :----------: |
| Wireframes        |       ✅        |        ✅         |      ✅       |      🟡      |
| ER diagrams       |       ✅        |        ✅         |      ✅       |      🟡      |
| Matrices          |       ✅        |        ✅         |      ✅       |      🟡      |
| Sequence diagrams |       ✅        |        ✅         |      ✅       |      🟡      |
| Mindmaps          |       ✅        |        ✅         |      ✅       |      🟡      |

🟡 = the frontmatter exists but no `data/` schema validates it yet — coverage a rollup could
turn green. A coverage matrix earns trust by having a column that isn't all ✅.

## 4. Risk matrix

|                   | Low impact | Medium impact       | High impact              |
| ----------------- | ---------- | ------------------- | ------------------------ |
| **Likely**        | 🟢 accept  | 🟡 diagram drift    | 🔴 SSOT split-brain      |
| **Possible**      | 🟢 accept  | 🟡 mermaid breakage | 🟡 orphaned frontmatter  |
| **Rare**          | 🟢 accept  | 🟢 accept           | 🟡 GitHub drops mermaid  |

Each 🔴/🟡 cell should name its risk — a heat map with anonymous cells is decoration, not
communication.
