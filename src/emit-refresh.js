/**
 * `gitdata emit refresh` — the structural fix for derived-view merge conflicts.
 *
 * A rolled-up view aggregates many rows into one rendered file. Any two branches that both
 * regenerate it therefore collide: text merge cannot combine two renders of the same artifact,
 * and a repo that requires every PR to commit fresh views has built a conflict engine — every
 * open PR conflicts with every other one the moment the first of them merges. The way out is
 * not a cleverer merge; it is fewer writers. Feature branches carry ROWS ONLY, and one workflow
 * on the integration branch regenerates the views after every push. Once no PR modifies a
 * rendered view, no two PRs can conflict on one. The whole argument: docs/MERGES.md.
 *
 * This module scaffolds that workflow. Two jobs travel in one file because they are two halves
 * of one contract:
 *
 *   refresh — on push to the named integration branches: re-run the consumer's rollup
 *             command(s), commit the delta under the named view directories, push. The single
 *             writer.
 *   guard   — on pull_request: fail if the PR changes any rendered `.md` under a view
 *             directory relative to its base. Rendered bytes in a PR are the conflict being
 *             reintroduced. Failing is all it does — whether that BLOCKS is branch
 *             protection's call, per the law: gitdata guides, GitHub enforces.
 *
 * UNLIKE `emit codeowners`, THIS IS A SCAFFOLD, NOT A DERIVED ARTIFACT. CODEOWNERS is a pure
 * function of `_owners.yml` rows, so it drift-checks. A workflow is a function of the
 * consumer's runtime — their package manager, their version pins, their store layout — which
 * gitdata cannot know and must not pretend to. So this follows `init`'s contract instead:
 * written once, never overwritten, yours to edit. There is no `--check`, deliberately; the CLI
 * refuses the flag rather than ignoring it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { EmitError } from "./emit-codeowners.js";

/** Double-quote for YAML. JSON string quoting is valid YAML double-quote quoting. */
const q = (s) => JSON.stringify(s);

/**
 * One list, three input rules, applied identically so the render is deterministic (law 4):
 * entries must be non-empty strings, order is preserved (argv order is explicit input, not
 * directory order), duplicates collapse to the first occurrence.
 */
function cleanList(values, fallback, flag, extraCheck) {
  const given = values && values.length > 0 ? values : fallback;
  const out = [];
  for (const raw of given) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new EmitError(`${flag} entries must be non-empty strings`);
    }
    const value = extraCheck ? extraCheck(raw) : raw;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * A view directory names a place inside the repo the workflow will `git add` wholesale. The
 * check is lexical, not filesystem: the directory legitimately may not exist yet in the repo
 * this runs against (a fresh store), and the workflow executes somewhere else entirely — the
 * runner — where resolving symlinks here would prove nothing. `rollup()` holds the real
 * write-containment line at render time; this only refuses paths that could not be inside any
 * repo checkout.
 */
function cleanViewsDir(raw, flag) {
  const dir = raw.replace(/\/+$/, "");
  if (dir === "" || isAbsolute(dir) || dir.split("/").includes("..") || dir.includes("\\")) {
    throw new EmitError(`${flag} must be a relative directory inside the repo — got ${q(raw)}`);
  }
  return dir;
}

/** A command becomes one line inside two `run: |` blocks; a newline would change what runs. */
function cleanCommand(raw, flag) {
  if (raw.includes("\n")) {
    throw new EmitError(`${flag} takes one command per flag — repeat the flag instead of embedding newlines`);
  }
  return raw;
}

/**
 * The workflow text. Deterministic: a pure function of the three lists, no timestamps, no
 * environment reads. The scaffolding command is recorded in the header so a reader can see
 * exactly what produced the file — and what to re-run after deleting it, which is the only
 * regeneration path a scaffold has.
 *
 * @param {{branches?: string[], runs?: string[], views?: string[]}} opts
 * @returns {string}
 */
export function renderRefreshWorkflow({ branches, runs, views } = {}) {
  const branchList = cleanList(branches, ["main"], "--branch");
  const runList = cleanList(runs, ["npx @marktiderman/gitdata rollup"], "--run", (v) => cleanCommand(v, "--run"));
  const viewList = cleanList(views, ["data/_views"], "--views", (v) => cleanViewsDir(v, "--views"));

  const scaffoldCmd = [
    "gitdata emit refresh",
    ...branchList.map((b) => `--branch ${q(b)}`),
    ...runList.map((r) => `--run ${q(r)}`),
    ...viewList.map((v) => `--views ${q(v)}`),
  ].join(" ");

  // Pathspecs for the shell lines. Single quotes survive the YAML literal block untouched and
  // keep the `*` out of the shell's hands — git expands the pathspec glob itself.
  const dirSpecs = viewList.map((v) => `"${v}"`).join(" ");
  const mdSpecs = viewList.map((v) => `'${v}/*.md'`).join(" ");

  return [
    "# gitdata-refresh.yml — the SINGLE WRITER for rendered gitdata views.",
    "#",
    `# Scaffolded by: ${scaffoldCmd}`,
    "#",
    "# WHY THIS EXISTS. A rolled-up view aggregates many rows into one rendered file,",
    "# so any two branches that both regenerate it collide — text merge cannot combine",
    "# two renders of the same artifact. A repo that requires every PR to commit fresh",
    "# views has built a conflict engine: every open PR conflicts with every other one",
    "# the moment the first of them merges. The fix is structural, not clever merging:",
    "# PRs carry ROWS ONLY, and this workflow is the one writer that regenerates the",
    "# views on the integration branch after every push. Once no PR modifies a rendered",
    "# view, no two PRs can conflict on one. Full doctrine: docs/MERGES.md in the",
    "# gitdata repository.",
    "#",
    "# THIS FILE IS A SCAFFOLD AND IT IS YOURS. Adapt the setup to your runtime (the",
    "# default assumes npx on a stock runner), pin versions, add stores. gitdata does",
    "# not drift-check it and never overwrites it.",
    "#",
    "# TWO CAVEATS, BOTH ABOUT ENFORCEMENT (gitdata guides; GitHub enforces):",
    "#   - The refresh push needs `contents: write`, and a branch ruleset that forbids",
    "#     direct pushes will reject the bot too. Either let github-actions[bot]",
    "#     through for that branch, or remove the branch here and let its views ride",
    "#     the (serial, reviewed) PRs that reach it.",
    "#   - The guard job only FAILS. Whether that blocks a merge is your branch",
    "#     protection's decision, not this file's.",
    "",
    "name: gitdata refresh",
    "",
    "on:",
    "  push:",
    "    branches:",
    ...branchList.map((b) => `      - ${q(b)}`),
    "  pull_request:",
    "",
    "permissions:",
    "  contents: write",
    "",
    "# One refresh at a time per branch, newest wins: a superseded run's regeneration is",
    "# contained in the newer run's, so cancelling it loses nothing.",
    "concurrency:",
    "  group: gitdata-refresh-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  # The single writer. Regenerates on the branch TIP (not the trigger commit): if",
    "  # pushes landed while this run waited its turn, it rolls them up too.",
    "  refresh:",
    "    if: github.event_name == 'push'",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          ref: ${{ github.ref_name }}",
    "",
    "      # <-- your runtime setup goes here if the commands below need more than npx",
    "",
    "      - name: Regenerate views and push if anything moved",
    "        env:",
    "          BRANCH: ${{ github.ref_name }}",
    "        run: |",
    '          git config user.name "github-actions[bot]"',
    '          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
    "          # Retry because the branch can move between fetch and push; every attempt",
    "          # starts over from the true tip, so the loop converges instead of racing.",
    "          for attempt in 1 2 3; do",
    '            git fetch --depth=1 origin "$BRANCH"',
    "            git reset --hard FETCH_HEAD",
    ...runList.map((r) => `            ${r}`),
    `            if git diff --quiet -- ${dirSpecs}; then`,
    '              echo "views already current"',
    "              exit 0",
    "            fi",
    `            git add -A -- ${dirSpecs}`,
    "            # --no-verify: local hooks are for humans; this commit touches only",
    "            # rendered views. [skip ci]: the commit that triggered us already ran",
    "            # whatever mattered, and a views-only commit deploys nothing.",
    '            git commit --no-verify -m "chore: refresh gitdata views [skip ci]"',
    '            if git push --no-verify origin "HEAD:$BRANCH"; then',
    "              exit 0",
    "            fi",
    '            echo "push rejected — the branch moved; retrying from its new tip"',
    "          done",
    '          echo "gave up after 3 attempts — re-run this workflow" >&2',
    "          exit 1",
    "",
    "  # The other half of the contract: a PR that changes a rendered view is the",
    "  # conflict being reintroduced, whatever its intentions. The diff is taken",
    "  # against the base TIP on the PR's merge ref, so it reads the PR's net effect",
    "  # — a stale view inherited from an old base does not trip it; only bytes this",
    "  # merge would change do.",
    "  guard:",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      - name: Rendered views belong to the integration branch, not to PRs",
    "        env:",
    "          BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    "          BASE_REF: ${{ github.base_ref }}",
    "        run: |",
    '          git fetch --depth=1 origin "$BASE_SHA"',
    `          changed=$(git diff --name-only "$BASE_SHA" HEAD -- ${mdSpecs})`,
    '          if [ -n "$changed" ]; then',
    '            echo "This PR changes rendered views — the refresh workflow regenerates these after merge:"',
    '            echo "$changed"',
    '            echo ""',
    '            echo "Peel them off and push again:"',
    '            echo "  git fetch origin \\"$BASE_REF\\""',
    `            echo "  git checkout \\"origin/$BASE_REF\\" -- ${mdSpecs.replace(/"/g, '\\"')}"`,
    "            echo \"  git commit -m 'drop rendered views — the integration branch is the writer'\"",
    "            exit 1",
    "          fi",
    '          echo "clean — this PR carries rows, not renders"',
    "",
  ].join("\n");
}

/**
 * Render, then write — or report that the consumer already owns one. `init`'s contract, not
 * `rollup`'s: a file that exists is left alone whatever it contains, because the moment it was
 * written it stopped being ours.
 *
 * @param {{outPath: string, branches?: string[], runs?: string[], views?: string[]}} opts
 * @returns {{status: "written"|"exists", out: string}}
 */
export function emitRefresh({ outPath, branches, runs, views }) {
  const compiled = renderRefreshWorkflow({ branches, runs, views });
  if (existsSync(outPath)) return { status: "exists", out: outPath };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, compiled, "utf8");
  return { status: "written", out: outPath };
}
