/**
 * `gitdata doctor` — the compliance verb.
 *
 * gitdata GUIDES; GitHub ENFORCES (docs/ARCHITECTURE.md rule 5). `doctor` therefore REPORTS. With
 * no flags it always exits 0, so it is safe to run in a dev shell and safe to run in a hook that
 * nobody asked to be blocking. `--check` is the opt-in that exits non-zero, exactly like
 * `rollup --check` and `validate` already do, so a consumer can wire ONE required CI line instead
 * of three: doctor folds those two verbs in as GD109 and GD110 rather than reimplementing them.
 *
 * Every check has a stable public ID and a default level. A consumer may lower any check in
 * `data/_gitdata.yml`, but lowering it requires a `reason:` — a suppression without one is itself
 * a finding (GD000). Lowered checks are printed in a trailing "silenced by policy" block with
 * their reasons, so a deliberate divergence stays visible and attributed instead of vanishing.
 *
 * Nothing here writes into `data/`, or anywhere else. `doctor` only reads.
 *
 * The engine names nothing (rule 1). Every check below is structural — a version range, a file
 * that does or does not exist, a column the CONSUMER named in their own manifest. No table name,
 * no column name, and no status value is hardcoded in this file.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import semver from "semver";
import { parse as parseYaml } from "yaml";

import { listPacks } from "./init.js";
import { isRowFile, load } from "./load.js";
import { loadViewSpecs, rollup } from "./rollup.js";
import { validate } from "./validate.js";

/** This engine's own manifest — the version and node range every version check compares against. */
const ENGINE_PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const ENGINE_NAME = ENGINE_PKG.name;
export const ENGINE_VERSION = ENGINE_PKG.version;
const ENGINE_NODE_RANGE = ENGINE_PKG.engines?.node ?? "*";

/**
 * The unscoped registry name, which is somebody else's 2016 package. Held as a constant rather
 * than written inline so that no file we ship ever contains a run command naming it — the rule
 * test/boundaries.test.js enforces across the whole tarball.
 */
const UNSCOPED = "git" + "data";

/**
 * The policy file. `_`-prefixed on purpose: `src/load.js` skips every `_`-prefixed entry directly
 * under a data root (and skips non-directories besides), so the loader already ignores this file
 * and it can never be mistaken for a row or a table. Verified against that loader, not assumed.
 */
export const POLICY_FILE = "_gitdata.yml";

/** Severity, most severe first. `off` still runs the check; it just cannot fail a build. */
export const LEVELS = ["error", "warn", "off"];
const RANK = { error: 2, warn: 1, off: 0 };

/** The three classes a table can be declared as. `class:` is optional; absent means unknown. */
export const TABLE_CLASSES = ["authored", "measured", "derived"];

/**
 * The check catalog. `id` is the public, stable name a consumer writes in their policy file; it
 * never changes meaning. `level` is the DEFAULT severity — policy may raise or lower it.
 *
 * docs/DOCTOR.md documents exactly these IDs, and test/boundaries.test.js asserts the two agree
 * in both directions, the same ratchet SHAPES.md already has against the shape registry.
 */
export const CHECKS = [
  { id: "GD000", name: "suppression-without-reason", level: "error", scope: "policy" },
  { id: "GD001", name: "unpinned-runner", level: "error", scope: "repo" },
  { id: "GD002", name: "install-disagrees", level: "error", scope: "repo" },
  { id: "GD003", name: "unscoped-package", level: "error", scope: "repo" },
  { id: "GD004", name: "behind-latest", level: "warn", scope: "repo", network: true },
  { id: "GD005", name: "pack-engine-range", level: "error", scope: "store" },
  { id: "GD006", name: "node-below-engines", level: "error", scope: "repo" },
  { id: "GD007", name: "engine-range-unsatisfied", level: "error", scope: "store" },
  { id: "GD103", name: "artifact-lands-in-a-table", level: "error", scope: "store" },
  { id: "GD109", name: "rollup-drift", level: "error", scope: "store" },
  { id: "GD110", name: "validate-issues", level: "error", scope: "store" },
  { id: "GD111", name: "measured-without-provenance", level: "warn", scope: "store" },
  { id: "GD112", name: "row-contract-reimplemented", level: "warn", scope: "repo" },
];

export const CHECK_IDS = CHECKS.map((c) => c.id);
const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

/** Frontmatter absence, YAML `null`, and an empty string all mean "nothing was written here". */
const isMissing = (v) => v === undefined || v === null || v === "";

const readJson = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// The policy file
// ---------------------------------------------------------------------------------------------

/**
 * Read `<dataRoot>/_gitdata.yml`.
 *
 * Never throws. A malformed policy file is a finding, not a crash: `doctor` with no flags must
 * exit 0 whatever it finds, so an unreadable input has to travel as a defect rather than as an
 * exception the CLI would turn into exit 1.
 *
 * A defect NEVER takes effect. An entry that is malformed, or lowered with no reason, is ignored
 * and the check keeps its default level — the safe direction, since the alternative is a silent
 * suppression created by a typo.
 *
 * @returns {{path: string, present: boolean, engine: string|null, checks: object,
 *            packs: object|null, tables: object|null, defects: string[]}}
 */
export function readPolicy(dataRoot) {
  const path = join(dataRoot, POLICY_FILE);
  const policy = { path, present: false, engine: null, checks: {}, packs: null, tables: null, scan: null, defects: [] };
  if (!existsSync(path)) return policy;
  policy.present = true;

  let doc;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    policy.defects.push(`${POLICY_FILE}: not valid YAML — ${cause.message}`);
    return policy;
  }
  if (doc == null) return policy; // an empty file is a legitimate no-op policy
  if (typeof doc !== "object" || Array.isArray(doc)) {
    policy.defects.push(`${POLICY_FILE}: must be a mapping`);
    return policy;
  }

  const KNOWN = ["engine", "checks", "packs", "tables", "scan"];
  for (const key of Object.keys(doc)) {
    if (!KNOWN.includes(key)) policy.defects.push(`${POLICY_FILE}: unknown key "${key}" — one of ${KNOWN.join(", ")}`);
  }

  if (doc.engine != null) {
    if (typeof doc.engine !== "string") policy.defects.push(`${POLICY_FILE}: "engine" must be a version range string`);
    else policy.engine = doc.engine;
  }

  if (doc.checks != null) {
    if (typeof doc.checks !== "object" || Array.isArray(doc.checks)) {
      policy.defects.push(`${POLICY_FILE}: "checks" must be a mapping of check id to {level, reason}`);
    } else {
      for (const [id, entry] of Object.entries(doc.checks)) {
        const check = BY_ID.get(id);
        if (!check) {
          policy.defects.push(`${POLICY_FILE}: unknown check id "${id}" — see docs/DOCTOR.md for the catalog`);
          continue;
        }
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
          policy.defects.push(`${POLICY_FILE}: checks.${id} must be a mapping with "level" (and "reason" to lower it)`);
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (key !== "level" && key !== "reason") {
            policy.defects.push(`${POLICY_FILE}: checks.${id} has unknown key "${key}" — one of level, reason`);
          }
        }
        const { level, reason } = entry;
        if (!LEVELS.includes(level)) {
          policy.defects.push(`${POLICY_FILE}: checks.${id} level "${level}" is not one of ${LEVELS.join(", ")}`);
          continue;
        }
        // Raising severity needs no justification; lowering one does. That asymmetry is the whole
        // point — a check nobody has to explain away is a check that quietly stops mattering.
        if (RANK[level] < RANK[check.level] && (typeof reason !== "string" || reason.trim() === "")) {
          policy.defects.push(
            `${POLICY_FILE}: checks.${id} lowers ${check.level} to ${level} with no "reason" — a suppression must say why`,
          );
          continue;
        }
        policy.checks[id] = { level, reason: typeof reason === "string" ? reason : null };
      }
    }
  }

  if (doc.scan != null) {
    if (!Array.isArray(doc.scan) || doc.scan.some((p) => typeof p !== "string")) {
      policy.defects.push(`${POLICY_FILE}: "scan" must be a list of path patterns`);
    } else {
      policy.scan = doc.scan;
    }
  }

  if (doc.packs != null) {
    if (typeof doc.packs !== "object" || Array.isArray(doc.packs)) {
      policy.defects.push(`${POLICY_FILE}: "packs" must be a mapping of pack name to installed version`);
    } else {
      policy.packs = {};
      for (const [name, version] of Object.entries(doc.packs)) {
        if (typeof version !== "string" || !semver.valid(version)) {
          policy.defects.push(`${POLICY_FILE}: packs.${name} must be an exact installed version, got ${JSON.stringify(version)}`);
          continue;
        }
        policy.packs[name] = version;
      }
    }
  }

  if (doc.tables != null) {
    if (typeof doc.tables !== "object" || Array.isArray(doc.tables)) {
      policy.defects.push(`${POLICY_FILE}: "tables" must be a mapping of table name to {class, written_by, provenance}`);
    } else {
      policy.tables = {};
      for (const [name, entry] of Object.entries(doc.tables)) {
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
          policy.defects.push(`${POLICY_FILE}: tables.${name} must be a mapping`);
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (!["class", "written_by", "provenance"].includes(key)) {
            policy.defects.push(`${POLICY_FILE}: tables.${name} has unknown key "${key}" — one of class, written_by, provenance`);
          }
        }
        if (entry.class != null && !TABLE_CLASSES.includes(entry.class)) {
          policy.defects.push(
            `${POLICY_FILE}: tables.${name} class "${entry.class}" is not one of ${TABLE_CLASSES.join(", ")}`,
          );
          continue;
        }
        if (entry.provenance != null && (!Array.isArray(entry.provenance) || entry.provenance.some((c) => typeof c !== "string"))) {
          policy.defects.push(`${POLICY_FILE}: tables.${name} "provenance" must be a list of column names`);
          continue;
        }
        policy.tables[name] = {
          class: entry.class ?? null,
          written_by: entry.written_by ?? null,
          provenance: entry.provenance ?? null,
        };
      }
    }
  }

  return policy;
}

// ---------------------------------------------------------------------------------------------
// Command scanning — the shared input for GD001 and GD003
// ---------------------------------------------------------------------------------------------

/** A specifier that is not an npm registry name cannot resolve to a registry package. */
const NON_REGISTRY = /^(?:github|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link|workspace|portal):/i;

const RUNNER = /\b(?:npx|bunx|pnpm\s+dlx|npm\s+exec|yarn\s+dlx)\b(.*)$/;
const INSTALL = /\b(?:npm\s+(?:install|add|i)|pnpm\s+(?:install|add|i)|yarn\s+add|bun\s+(?:install|add)|deno\s+add)\b(.*)$/;

/** Split a shell command on the operators that end one invocation and begin the next. */
const segments = (command) => String(command).split(/&&|\|\||[;|\n]/);

/** A command-line token reduced to `{name, version}`, or null when it names no registry package. */
function packageSpec(raw) {
  const s = raw.replace(/^[('"`]+|[)'"`,;]+$/g, "").trim();
  if (!s || s.startsWith("-")) return null;
  const bare = s.startsWith("npm:") ? s.slice(4) : s;
  if (NON_REGISTRY.test(bare)) return null;
  const at = bare.indexOf("@", bare.startsWith("@") ? 1 : 0);
  const name = at > 0 ? bare.slice(0, at) : bare;
  const version = at > 0 ? bare.slice(at + 1) : null;
  return name ? { name, version } : null;
}

const nonFlagTokens = (tail) =>
  tail
    .split(/\s+/)
    .filter((t) => t && t !== "--" && !t.startsWith("-"))
    .map(packageSpec)
    .filter(Boolean);

/**
 * Where a run command can live, by default.
 *
 * Deliberately NOT "every source file". A scan that wide hits package names in prose, in test
 * fixtures, and in the very docs that tell people how to pin — and a check that cries wolf is a
 * check people learn to skip. These three are where an invocation actually executes. A consumer
 * whose repo is unusual widens it themselves via `scan:` in the policy file, deliberately, rather
 * than the tool guessing on everyone's behalf.
 */
export const DEFAULT_SCAN = ["package.json", ".github/workflows/*.yml", ".github/workflows/*.yaml", "**/*.sh"];

/** Directories no scan should ever walk into. */
const UNSCANNED = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor"]);

/**
 * A tiny glob: `**` crosses separators, `*` does not, everything else is literal. Enough for path
 * patterns a consumer writes by hand, and no dependency for it.
 */
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match zero directories, so `**/*.sh` also matches `x.sh` at the root.
        source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Every file under `root` (posix-separated, relative) matching any of `patterns`. */
function filesMatching(root, patterns) {
  const matchers = patterns.map(globToRegExp);
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (UNSCANNED.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
        walk(join(dir, entry.name), rel);
      } else if (matchers.some((m) => m.test(rel))) {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Every run command in the repo, with where it came from.
 *
 * How a file is read depends on what it is: `package.json` yields its `scripts` values, a workflow
 * is PARSED as YAML and walked for `run:` values (so a package name in a comment or a `uses:` line
 * is never mistaken for an invocation), and anything else — a shell script — is read whole. A
 * workflow that will not parse falls back to a whole-file read rather than being skipped silently.
 *
 * @param {string} root
 * @param {string[]} [patterns] path globs relative to root; defaults to DEFAULT_SCAN
 * @returns {Array<{where: string, command: string}>}
 */
export function runCommands(root, patterns = DEFAULT_SCAN) {
  const out = [];

  for (const rel of filesMatching(root, patterns)) {
    const path = join(root, rel);
    if (rel === "package.json" || rel.endsWith("/package.json")) {
      const pkg = readJson(path);
      for (const [name, script] of Object.entries(pkg?.scripts ?? {})) {
        if (typeof script === "string") out.push({ where: `${rel} → scripts.${name}`, command: script });
      }
      continue;
    }

    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    if (rel.endsWith(".yml") || rel.endsWith(".yaml")) {
      let doc;
      try {
        doc = parseYaml(text);
      } catch {
        out.push({ where: rel, command: text });
        continue;
      }
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (key === "run" && typeof value === "string") out.push({ where: `${rel} → run`, command: value });
          else walk(value);
        }
      };
      walk(doc);
      continue;
    }

    out.push({ where: rel, command: text });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const finding = (id, message, where = null) => ({ id, check: BY_ID.get(id).name, message, where });

/**
 * GD001 — a runner invoking this package with no `@<version>`.
 *
 * `--check` compares bytes, so a floating engine turns a build red with no change in the
 * consumer's own repo. That is the failure this catches, and it is silent until the day it isn't.
 */
function checkUnpinnedRunner({ commands }) {
  const findings = [];
  for (const { where, command } of commands) {
    for (const segment of segments(command)) {
      const m = RUNNER.exec(segment);
      if (!m) continue;
      const [spec] = nonFlagTokens(m[1]);
      if (spec && spec.name === ENGINE_NAME && !spec.version) {
        findings.push(finding("GD001", `${ENGINE_NAME} is invoked with no @<version> — pin the version you tested against`, where));
      }
    }
  }
  return { findings };
}

/** GD003 — a runner or an install command whose package position names the unscoped registry name. */
function checkUnscoped({ commands }) {
  const findings = [];
  const forbidden = (n) => n === UNSCOPED || n.startsWith(`@${UNSCOPED}/`);
  for (const { where, command } of commands) {
    for (const segment of segments(command)) {
      const run = RUNNER.exec(segment);
      if (run) {
        const [spec] = nonFlagTokens(run[1]);
        if (spec && forbidden(spec.name)) {
          findings.push(finding("GD003", `runs the unscoped "${spec.name}" — an unrelated package by another author; use ${ENGINE_NAME}`, where));
        }
      }
      const install = INSTALL.exec(segment);
      if (install) {
        for (const spec of nonFlagTokens(install[1])) {
          if (forbidden(spec.name)) {
            findings.push(finding("GD003", `installs the unscoped "${spec.name}" — an unrelated package by another author; use ${ENGINE_NAME}`, where));
          }
        }
      }
    }
  }
  return { findings };
}

const DEP_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** The declared range for this package in the consumer's manifest, and which block declared it. */
function declaredDep(pkg) {
  for (const block of DEP_BLOCKS) {
    const range = pkg?.[block]?.[ENGINE_NAME];
    if (typeof range === "string") return { block, range };
  }
  return null;
}

/** GD002 — the package is declared but absent from node_modules, or the lockfile disagrees. */
function checkInstall({ root }) {
  const findings = [];
  const skipped = [];
  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return { findings, skipped: ["no package.json at the root — nothing declares a dependency to disagree with"] };

  const declared = declaredDep(pkg);
  if (!declared) return { findings, skipped: [`package.json declares no dependency on ${ENGINE_NAME}`] };

  const installedPkg = readJson(join(root, "node_modules", ...ENGINE_NAME.split("/"), "package.json"));
  const installed = installedPkg?.version ?? null;
  if (!installed) {
    findings.push(
      finding("GD002", `${declared.block} declares ${ENGINE_NAME}@${declared.range} but it is absent from node_modules — run your install`, "package.json"),
    );
  }

  const lock = readJson(join(root, "package-lock.json"));
  if (!lock) {
    skipped.push("no package-lock.json — lockfile agreement not checked (only npm's lockfile format is read)");
  } else {
    const entry = lock.packages?.[`node_modules/${ENGINE_NAME}`];
    if (!entry?.version) {
      findings.push(finding("GD002", `package-lock.json has no entry for ${ENGINE_NAME} while package.json declares one`, "package-lock.json"));
    } else {
      if (semver.validRange(declared.range) && !semver.satisfies(entry.version, declared.range)) {
        findings.push(
          finding("GD002", `package-lock.json pins ${entry.version}, outside the ${declared.range} package.json declares`, "package-lock.json"),
        );
      }
      if (installed && installed !== entry.version) {
        findings.push(
          finding("GD002", `node_modules holds ${installed} but package-lock.json pins ${entry.version}`, "node_modules"),
        );
      }
    }
  }

  return { findings, skipped };
}

const REGISTRY = "https://registry.npmjs.org";

/** The default network probe for GD004. Returns null on any failure — a check never throws. */
async function fetchLatestVersion() {
  try {
    const url = `${REGISTRY}/${ENGINE_NAME.replace("/", "%2F")}/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * GD004 — the installed engine is behind the latest published one. The only network check, and
 * the only one that defaults to `warn`: being a version behind is a fact worth surfacing, never a
 * reason to fail somebody's build.
 */
async function checkBehindLatest({ root, offline, fetchLatest }) {
  if (offline) return { findings: [], skipped: ["--offline — the registry was not contacted"] };

  const installedPkg = readJson(join(root, "node_modules", ...ENGINE_NAME.split("/"), "package.json"));
  const installed = installedPkg?.version ?? ENGINE_VERSION;
  const latest = await fetchLatest();
  if (!latest) return { findings: [], skipped: ["the registry could not be reached — version currency is UNKNOWN"] };
  if (!semver.valid(installed) || !semver.valid(latest)) {
    return { findings: [], skipped: [`could not compare ${installed} against ${latest} — version currency is UNKNOWN`] };
  }
  if (semver.lt(installed, latest)) {
    return { findings: [finding("GD004", `${installed} is installed; ${latest} is published`)] };
  }
  return { findings: [] };
}

/**
 * GD005 — an installed pack's `requires:` range excludes the running engine.
 *
 * `requires:` has been declared in every `pack.yml` since packs existed and read by NOTHING (the
 * only other reference is a boundaries test asserting the key is present). This is the check that
 * gives it teeth.
 *
 * It needs to know WHICH packs are installed, and at what version. Nothing records that yet —
 * `init` copies a pack's files and writes no receipt — so this check SKIPS cleanly rather than
 * erroring when there is nothing to read. The receipt shape it reads today is `packs:` in the
 * policy file; when `init` starts writing one, this reads it unchanged.
 */
function checkPackRange({ policy, bundledPacks }) {
  const findings = [];
  const skipped = [];
  const receipt = policy.packs;
  if (!receipt || Object.keys(receipt).length === 0) {
    return {
      findings,
      skipped: [`no pack receipt — nothing records which packs are installed yet, so \`requires:\` has nothing to compare against`],
    };
  }

  const bundled = new Map(bundledPacks().map((p) => [p.name, p]));
  for (const [name, version] of Object.entries(receipt)) {
    const pack = bundled.get(name);
    if (!pack) {
      skipped.push(`pack "${name}" is not bundled with this engine — its \`requires:\` is UNKNOWN`);
      continue;
    }
    if (pack.version !== version) {
      skipped.push(
        `pack "${name}" ${version} is recorded installed; this engine bundles ${pack.version} — the installed manifest's \`requires:\` is UNKNOWN`,
      );
      continue;
    }
    if (!pack.requires || !semver.validRange(pack.requires)) {
      findings.push(finding("GD005", `pack "${name}" declares an unreadable requires range ${JSON.stringify(pack.requires ?? null)}`));
      continue;
    }
    if (!semver.satisfies(ENGINE_VERSION, pack.requires, { includePrerelease: true })) {
      findings.push(finding("GD005", `pack "${name}" ${version} requires engine ${pack.requires}; ${ENGINE_VERSION} is running`));
    }
  }
  return { findings, skipped };
}

/** GD006 — the running node is below what this engine's `engines.node` declares. */
function checkNode({ nodeVersion }) {
  const current = nodeVersion;
  if (!semver.validRange(ENGINE_NODE_RANGE)) {
    return { findings: [], skipped: [`this engine declares an unreadable engines.node — UNKNOWN`] };
  }
  if (!semver.satisfies(current, ENGINE_NODE_RANGE, { includePrerelease: true })) {
    return { findings: [finding("GD006", `node ${current} is running; ${ENGINE_NAME} declares engines.node ${ENGINE_NODE_RANGE}`)] };
  }
  return { findings: [] };
}

/**
 * GD007 — the running engine is outside the range the consumer declared.
 *
 * The policy file's `engine:` key exists because a store pins the engine it was authored against.
 * A declared range that nothing reads is the exact defect GD005 was built to end, so this file
 * does not ship one.
 */
function checkEngineRange({ policy }) {
  if (!policy.engine) {
    return { findings: [], skipped: [`no \`engine:\` declared in ${POLICY_FILE} — the required engine range is UNKNOWN`] };
  }
  if (!semver.validRange(policy.engine)) {
    return { findings: [finding("GD007", `\`engine: ${policy.engine}\` is not a readable version range`, POLICY_FILE)] };
  }
  if (!semver.satisfies(ENGINE_VERSION, policy.engine, { includePrerelease: true })) {
    return { findings: [finding("GD007", `this store declares engine ${policy.engine}; ${ENGINE_VERSION} is running`, POLICY_FILE)] };
  }
  return { findings: [] };
}

/**
 * GD103 — a view whose `out:` lands inside a table directory, where the next load reads it back
 * as a row.
 *
 * This EXTENDS the `_` convention this project already ships; it does not invent a path law.
 * `src/load.js` skips every `_`-prefixed entry, so `out: data/_views/board.md` is already safe by
 * construction and is exactly what the bundled pack does. `out: data/features/board.md` is not:
 * that file has a `.md` extension, sits directly under a table, and satisfies `isRowFile()`, so
 * the artifact becomes a row of that table on the next `load()` — silently, which is the failure
 * this project exists to prevent.
 *
 * The rule is therefore not "artifacts never land in data/". It is the narrow one the loader
 * already guarantees: anywhere under `data/` that is not `_`-prefixed is rows.
 */
function checkArtifactPath({ root, dataRoot }) {
  let specs;
  try {
    specs = loadViewSpecs(dataRoot);
  } catch (cause) {
    // A spec that will not parse is GD109's finding to report, not this one's — saying it twice
    // would double-count one defect across two check ids.
    return { findings: [], skipped: [`view specs could not be read (see GD109) — ${cause.message}`] };
  }
  if (specs.length === 0) return { findings: [], skipped: ["no view specs under data/_views/"] };

  const findings = [];
  for (const spec of specs) {
    // `out:` is repo-root-relative (rollup resolves it against repoRoot). Re-express it relative
    // to `data/`, because only the first level under `data/` names a table.
    const rel = relative(dataRoot, resolve(root, spec.out));
    if (rel.startsWith("..") || isAbsolute(rel)) continue; // outside data/ entirely — not a row, ever
    const [top, ...rest] = rel.split(/[\\/]/);
    if (rest.length === 0) continue; // a file directly in data/ is not inside a table
    if (top.startsWith("_") || top.startsWith(".")) continue; // the reserved namespace: never loaded
    if (!isRowFile(rest[rest.length - 1])) continue; // the loader would not read it back as a row
    findings.push(
      finding(
        "GD103",
        `writes into the "${top}" table, where load() reads it back as a row — put it under an \`_\`-prefixed directory (data/_views/), which the loader skips`,
        spec._file,
      ),
    );
  }
  return { findings };
}

/** GD109 — delegated `rollup --check`. Folded in, never reimplemented. */
async function checkRollup({ root, dataRoot }) {
  let results;
  try {
    results = await rollup({ dataRoot, repoRoot: root, check: true });
  } catch (cause) {
    return { findings: [finding("GD109", `rollup could not run — ${cause.message}`)] };
  }
  if (results.length === 0) return { findings: [], skipped: ["no view specs under data/_views/"] };
  const findings = results
    .filter((r) => r.status === "drifted" || r.status === "missing")
    .map((r) => finding("GD109", `view "${r.id}" is ${r.status} — run \`gitdata rollup\` and commit the result`, r.out));
  return { findings };
}

/** GD110 — delegated `validate`. Folded in, never reimplemented. */
function checkValidate({ dataRoot }) {
  let result;
  try {
    result = validate({ dataRoot });
  } catch (cause) {
    return { findings: [finding("GD110", `validate could not run — ${cause.message}`)] };
  }
  if (result.tables.length === 0) return { findings: [], skipped: ["no schemas under data/_schema/"] };
  const findings = result.issues.map((i) =>
    finding("GD110", `${i.table}: ${i.rule} — ${i.message}`, `data/${i.table}/${i.file}`),
  );
  return { findings };
}

/**
 * GD111 — a table declared `class: measured` whose rows carry no provenance.
 *
 * A measured table is rewritten wholesale by a machine, so a hand-authored row in one is destroyed
 * on the next run with no error. `class:` is how a store says that out loud; provenance columns
 * are how a reader tells a machine-written row from a hand-written one.
 *
 * WHICH columns count as provenance is the consumer's vocabulary, so they name them in their own
 * manifest — the engine only checks that the columns they named carry a value. It could not
 * hardcode a column name without breaking rule 1.
 *
 * Fail-open is not acceptable here: an undeclared `class:` SKIPS and says so. It never passes.
 */
function checkMeasuredProvenance({ dataRoot, policy }) {
  const findings = [];
  const skipped = [];
  const declared = policy.tables;
  if (!declared || Object.keys(declared).length === 0) {
    return { findings, skipped: [`no table declares a \`class:\` in ${POLICY_FILE} — every table's class is UNKNOWN`] };
  }

  const measured = Object.entries(declared).filter(([, spec]) => spec.class === "measured");
  const unclassed = Object.entries(declared).filter(([, spec]) => spec.class == null).map(([name]) => name);
  if (unclassed.length > 0) skipped.push(`declared with no \`class:\`, so unchecked: ${unclassed.sort().join(", ")}`);
  if (measured.length === 0) {
    skipped.push("no table is declared `class: measured`");
    return { findings, skipped };
  }

  const tables = existsSync(dataRoot) ? load(dataRoot) : new Map();
  for (const [name, spec] of measured.sort(([a], [b]) => a.localeCompare(b))) {
    const table = tables.get(name);
    if (!table) {
      skipped.push(`table "${name}" is declared \`class: measured\` but has no directory under data/`);
      continue;
    }
    const columns = spec.provenance ?? [];
    if (columns.length === 0) {
      findings.push(
        finding(
          "GD111",
          `table "${name}" is \`class: measured\` but declares no \`provenance:\` columns — nothing distinguishes a machine-written row from a hand-written one`,
          POLICY_FILE,
        ),
      );
      continue;
    }
    for (const row of table.rows) {
      if (columns.every((column) => isMissing(row[column]))) {
        findings.push(
          finding("GD111", `row carries none of the provenance columns ${columns.join(", ")} declared for "${name}"`, `data/${name}/${row._file}`),
        );
      }
    }
  }
  return { findings, skipped };
}

/**
 * GD112 — a file that appears to reimplement the row contract instead of importing it.
 *
 * `isRowFile` is exported precisely because a consumer that writes into `data/` has to answer the
 * same question the loader answers, and a copy is free to drift. A copy missing one clause either
 * deletes a file the loader protects or leaves one it reads — silently, on both sides.
 *
 * THIS IS A HEURISTIC, and it says so in its own message. It is a fuzzy text scan over source
 * files, and it is `warn` for that reason. The narrower design — look only at files that already
 * import this package — was considered and rejected: the very defect that motivated the check was
 * a script that reimplements the predicate and never imports gitdata at all, because it shells out
 * to a runner. A check that structurally cannot see the case it was built for is theatre, and a
 * warning that occasionally over-fires is recoverable.
 *
 * The file that DEFINES and exports the predicate is not reimplementing it, and neither is a file
 * that imports it. Both are exempt.
 */
const SOURCE_EXT = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb", ".go", ".sh"];
const MD_TEST = /\.md['"`]\s*\)|endsWith\(\s*['"`]\.md|\*\.md|\.md['"`]\s*$/m;
const UNDERSCORE_TEST = /startsWith\(\s*['"`]_|\bstartswith\(\s*['"`]_|\^_|['"`]_['"`]/;
const README_TEST = /readme/i;

function checkRowContract({ root }) {
  const files = filesMatching(root, SOURCE_EXT.map((e) => `**/*${e}`));
  const findings = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    // Two exemptions, and both are about NOT flagging a correct shape.
    //
    // The definition site: a file that exports the predicate under its published name is the
    // contract, not a copy of it. A copy that matters wears a different name — `isRow`, an inline
    // conjunction, a shell pipeline — and still fires.
    if (/export\s+(?:const|function)\s+isRowFile\b/.test(text)) continue;
    // A CALL site: importing the predicate is exactly the adoption this check asks for. The
    // specifier is deliberately not restricted to the package name — the engine's own tests import
    // it by relative path, and a consumer re-exporting it through a local module is still a call
    // site. If that local module is itself a hand-rolled copy, the copy is what gets flagged.
    if (/import[\s\S]{0,200}?\b(?:isRowFile|rowFilesIn)\b[\s\S]{0,200}?from\s*['"`]/.test(text)) continue;
    if (/\b(?:isRowFile|rowFilesIn)\b\s*[},][\s\S]{0,120}?\brequire\s*\(/.test(text)) continue;

    // The conjunction is what makes this a row predicate rather than an ordinary path test: a
    // `.md` extension check, an `_`-prefix exclusion, AND a README exclusion, in one file.
    if (MD_TEST.test(text) && UNDERSCORE_TEST.test(text) && README_TEST.test(text)) {
      findings.push(
        finding(
          "GD112",
          `looks like a hand-rolled copy of the row contract (a .md test, an "_" exclusion and a README exclusion together) — import isRowFile/rowFilesIn from ${ENGINE_NAME} instead. THIS IS A HEURISTIC: if it is not a row predicate, lower GD112 in ${POLICY_FILE} with a reason`,
          rel,
        ),
      );
    }
  }
  if (files.length === 0) return { findings, skipped: ["no source files to scan"] };
  return { findings };
}

const RUNNERS = {
  GD001: checkUnpinnedRunner,
  GD002: checkInstall,
  GD003: checkUnscoped,
  GD004: checkBehindLatest,
  GD005: checkPackRange,
  GD006: checkNode,
  GD007: checkEngineRange,
  GD103: checkArtifactPath,
  GD109: checkRollup,
  GD110: checkValidate,
  GD111: checkMeasuredProvenance,
  GD112: checkRowContract,
};

// ---------------------------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------------------------

/**
 * Run every check and report. Reads only; writes nothing, anywhere.
 *
 * `fetchLatest`, `bundledPacks` and `nodeVersion` are seams, not configuration. Each names the one
 * input its check cannot obtain twice in a test run — the registry, the set of packs shipped in
 * THIS tarball, and the node the process is already running on. Without them GD004, GD005 and
 * GD006 could only ever be observed not firing, and a check nobody has watched fire is a check
 * nobody has tested.
 *
 * @param {{root: string, offline?: boolean, fetchLatest?: () => Promise<string|null>,
 *          bundledPacks?: () => Array, nodeVersion?: string}} opts
 * @returns {Promise<{findings: Array, silenced: Array, skipped: Array, summary: {error: number, warn: number, off: number}, checked: number}>}
 */
export async function doctor({
  root,
  // Defaults to `<root>/data`, so every existing caller is unaffected. It is a parameter at all
  // because `doctor` reads the SAME tables `validate` and `rollup` read: a consumer who points
  // those at another directory with `--data` and gets a compliance report about `<root>/data`
  // has been told their store is healthy by a command that never opened it.
  dataRoot = join(root, "data"),
  offline = false,
  fetchLatest = fetchLatestVersion,
  bundledPacks = listPacks,
  nodeVersion = process.versions.node,
} = {}) {
  const policy = readPolicy(dataRoot);
  // `scan:` REPLACES the defaults rather than extending them, so a consumer can narrow as well as
  // widen and the effective list is always exactly what their file says.
  const commands = runCommands(root, policy.scan ?? DEFAULT_SCAN);
  const ctx = { root, dataRoot, policy, offline, fetchLatest, bundledPacks, nodeVersion, commands };

  const levelOf = (id) => policy.checks[id]?.level ?? BY_ID.get(id).level;

  const raw = [];
  const skipped = [];

  // GD000 first: a policy the tool could not honour is the finding that explains every other
  // level in the report.
  for (const message of policy.defects) raw.push(finding("GD000", message, POLICY_FILE));

  for (const check of CHECKS) {
    const run = RUNNERS[check.id];
    if (!run) continue;
    const result = await run(ctx);
    raw.push(...result.findings);
    for (const reason of result.skipped ?? []) skipped.push({ id: check.id, check: check.name, reason });
  }

  const findings = raw
    .map((f) => ({ ...f, level: levelOf(f.id) }))
    .sort((a, b) => a.id.localeCompare(b.id) || String(a.where).localeCompare(String(b.where)) || a.message.localeCompare(b.message));

  const silenced = CHECKS.filter((c) => RANK[levelOf(c.id)] < RANK[c.level]).map((c) => ({
    id: c.id,
    check: c.name,
    from: c.level,
    level: levelOf(c.id),
    reason: policy.checks[c.id]?.reason ?? null,
    findings: findings.filter((f) => f.id === c.id).length,
  }));

  const summary = {
    error: findings.filter((f) => f.level === "error").length,
    warn: findings.filter((f) => f.level === "warn").length,
    off: findings.filter((f) => f.level === "off").length,
  };

  return { findings, silenced, skipped, summary, checked: CHECKS.length, policy: { present: policy.present, path: relative(root, policy.path) } };
}

/**
 * The exit code contract, in one place so the CLI cannot drift from it.
 *
 * No flags → 0, always. `--check` → 1 on any error. `--strict` → `--check` plus warns count.
 * `off` never fails anything; that is what makes it worth requiring a reason for.
 */
export function exitCode(summary, { check = false, strict = false } = {}) {
  if (strict) return summary.error > 0 || summary.warn > 0 ? 1 : 0;
  if (check) return summary.error > 0 ? 1 : 0;
  return 0;
}
