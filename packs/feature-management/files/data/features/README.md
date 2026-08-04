# features

One file = one feature. The frontmatter is the data; the body is for people.

| field | meaning |
| --- | --- |
| `id` | **Immutable for life.** Never renamed, renumbered, or reused — everything else points at it. |
| `title` | A short, plain name. |
| `status` | `idea` · `planned` · `building` · `shipped` · `dropped` |
| `priority` | `P0` (now) → `P3` (someday) |
| `parent` | Another feature's `id`, for sub-features. `null` for top-level. |
| `owner` | Who is accountable. `null` if nobody yet. |
| `tags` | Free-form list. |
| `created` / `updated` | ISO dates. |

**Status lives in frontmatter, never in the folder.** Moving a file is not a state change — a
shipped feature stays exactly where it was, with `status: shipped`. That is what keeps links,
history, and blame intact.

## Adding one

```bash
cp data/features/_template.md data/features/F-001--my-feature.md
# edit it, then:
npx github:marktiderman/gitdata rollup
```

The board at `data/_views/features-board.md` regenerates from these files. Never edit the board
by hand — `gitdata rollup --check` fails if you do, because a board that disagrees with its
sources is worse than no board.
