# ideas

Good ideas nobody is building yet, and the record of the ones we decided against.

**This is gitdata's own store — the tool used on itself.** It is not shipped: `files` in
`package.json` lists `src`, `packs`, `docs`, `README.md`, `SHAPES.md` and `LICENSE`, and `data/` is
deliberately absent. "Core ships zero tables" governs what the *package* carries; a repo keeping its
own store is the tool being used, not the tool growing a table.

One row per idea, in `data/ideas/<id>--<slug>.md`. Copy [`_template.md`](_template.md).

## The two fields that do the work

**`solves`** — the problem it removes, or what it would let us stop doing. Required. If you cannot
answer either, it is a preference, and preferences do not get rows.

**`raised`** — where it came from: a session, an issue, a PR, a person. Required, because an idea
whose provenance is lost cannot be re-argued. Six months on, "we considered that" is unfalsifiable
without it.

## The one axis

`open` → `became` → `declined`. There is no `building`: the moment an idea is being built it has an
issue or a PR, and that is where its status lives. Two places tracking one state is how boards start
lying.

`became` names what it turned into (`#16`). `verdict` says what answered a declined idea. Neither is
required, because requiring a field that is only meaningful in one state teaches people to type
filler.

## Regenerating the board

```sh
node src/cli.js rollup --root .          # rewrite _views/ideas-board.md from these rows
node src/cli.js rollup --check --root .  # fail if the board has drifted
node src/cli.js validate --root .        # check rows against _schema/ideas.schema.yml
```

Run them bare and read `$?` directly. `$?` after a pipeline is the pipe's exit code, not the
command's.

**The board is generated. Do not hand-edit it** — `rollup --check` will fail if you do, which is the
whole point of it existing.
