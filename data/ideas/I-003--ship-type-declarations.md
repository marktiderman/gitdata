---
kind: idea-record
id: I-003
title: "Ship type declarations, so the contract we tell consumers to import is typed"
state: open
solves: "The package exports `isRowFile`/`rowFilesIn` and tells consumers to import them instead of reimplementing the row contract — but ships zero .d.ts and no `types` condition, so a TypeScript consumer who follows that advice gets TS7016 and has to declare the module themselves."
raised: "Session 2026-08-07 — hit as a real CI failure in a downstream consumer (gamify-platform `Charter - Keystone + GameSpec`), traced to the published tarball."
became: null
verdict: null
tags: [types, dx, exports, consumers]
created: 2026-08-07
---

# Ship type declarations, so the contract we tell consumers to import is typed

## Why

Measured against the published tarball, not the working tree:

```
$ npm pack @marktiderman/gitdata@0.2.0
--- .d.ts count in published 0.2.0: 0 ---

$ node -p "exports map"
{ "./load": { "import": "./src/load.js", "default": "./src/load.js" } }
```

Zero declarations, and no `types` condition on any export.

The irony is the argument. PR #11 exported the row contract specifically so consumers would stop
reimplementing it, and `doctor`'s GD112 check nags them when they do. A real consumer followed that
advice in TypeScript:

```
scripts/verify-game-registration.ts(148,27): error TS7016:
  Could not find a declaration file for module '@marktiderman/gitdata/load'.
```

Their CI went red. Their options are to `@ts-ignore` it, or hand-write a `declare module` — which is
a hand-rolled copy of our contract, the exact thing GD112 exists to stop. **We are telling consumers
to import a contract we do not type, and flagging them when they work around it.**

## The shape

Two candidates, and the choice is a real one:

**A — hand-written `.d.ts` beside each public module, plus a boundaries test.** No build step, no
TypeScript dependency, and drift is caught by the ratchet this repo already uses twice: `SHAPES.md`
must document exactly the registered shapes, `docs/DOCTOR.md` must document exactly the registered
checks. A third — "every named export in `src/index.js` and `src/load.js` has a declaration" — is
the same pattern and costs one test.

**B — generate from JSDoc** (`tsc --allowJs --declaration --emitDeclarationOnly`). No hand-written
duplication and the source comments become the types. Costs a devDependency on TypeScript and a
build step before publish.

**A is the recommendation**, because the repo's restraint looks deliberate: two runtime
dependencies, no build, `src/index.js` IS the contract. B trades that for convenience. The public
surface is small enough that hand-writing it is an afternoon, and the ratchet makes the drift risk
that motivates B into a test failure instead of a silent lie.

Either way the `exports` map gains a `types` condition — without it, declarations exist but
`moduleResolution: node16`/`bundler` still will not find them.

## Why it fits the laws

Domain-ignorant, no query-language change, no determinism impact. It does not move the format —
`.d.ts` files describe the JS, they do not touch a single row. Option B adds a build step, which is
the only real tension with how this package has been kept.

## Done when

A TypeScript consumer with `moduleResolution: bundler` imports `isRowFile` from
`@marktiderman/gitdata/load` and typechecks clean, `npm pack` shows the declarations present, and a
boundaries test fails if a named export gains no declaration.
