# Security

## Supported versions

The latest 0.x release only.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) rather than a public issue.

Worth knowing when assessing impact: `gitdata` executes consumer-authored SQL against an
ephemeral in-memory SQLite database built from the consumer's own repo, and a view's `compile:`
escape hatch executes a JS module from inside that same repo. Both are code the consumer already
controls — the trust boundary that matters is the repo itself and anything a third-party pack
asks you to install. `rollup` refuses to read code or write artifacts outside the repo root,
including through symlinks; a bypass of that containment is exactly the kind of report we want.
