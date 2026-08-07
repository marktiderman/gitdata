/**
 * Layer-boundary tests — the rules in docs/ARCHITECTURE.md, made mechanical.
 *
 * Vocabulary does not leak in one commit; it leaks one comment at a time, usually while porting a
 * view from the repo that motivated the feature. These tests are the ratchet.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { parse as parseYaml } from "yaml";

import { CHECKS } from "../src/doctor.js";
import { SHAPES } from "../src/shapes/index.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");
const PACKS = join(REPO, "packs");

const manifest = () => JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

const filesWithExt = (dir, ext) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? filesWithExt(p, ext) : extname(p) === ext ? [p] : [];
  });

const files = (dir) => filesWithExt(dir, ".js");

/**
 * A pack is a directory holding a `pack.yml` — the same rule `listPacks` applies in src/init.js.
 * Enumerating `packs/` by hand instead treats a stray `README.md` as a pack and throws when the
 * directory is absent.
 */
const packDirs = () =>
  existsSync(PACKS)
    ? readdirSync(PACKS, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(PACKS, e.name, "pack.yml")))
        .map((e) => e.name)
        .sort()
    : [];

/** Public prose that a new reader meets first. Vocabulary leaks here as readily as in code. */
const PUBLIC_DOCS = ["README.md", "SHAPES.md", "CONTRIBUTING.md", "docs/ARCHITECTURE.md", "docs/DOCTOR.md"];

/**
 * Words that name somebody's data rather than a mechanism. A consumer's vocabulary in the engine
 * means the engine has learned something only one repo could have taught it.
 *
 * Deliberately not a list of every possible domain word — it is a tripwire for the specific way
 * this has gone wrong before: porting a view and carrying its nouns along with it.
 */
const CONSUMER_WORDS = [
  "genesis",
  "cleanse",
  "territor",
  "ccp",
  "roadmap",
  "sprint",
  "standup",
  "okr",
];

describe("layer boundaries", () => {
  test("the engine and shapes name no consumer vocabulary", () => {
    const offenders = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const word of CONSUMER_WORDS) {
        if (text.includes(word)) offenders.push(`${file.slice(REPO.length + 1)}: "${word}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `consumer vocabulary found in src/ — see docs/ARCHITECTURE.md rule 1:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("the public docs name no consumer vocabulary", () => {
    // Caught a real leak: SHAPES.md credited each shape to the private repo whose view motivated
    // it, which says nothing to an outside reader and names somebody's internals in public prose.
    const offenders = [];
    for (const rel of PUBLIC_DOCS) {
      const text = readFileSync(join(REPO, rel), "utf8").toLowerCase();
      for (const word of CONSUMER_WORDS) {
        if (text.includes(word)) offenders.push(`${rel}: "${word}"`);
      }
    }
    assert.deepEqual(offenders, [], `consumer vocabulary in public docs:\n  ${offenders.join("\n  ")}`);
  });

  test("no shipped pack is named for a specific organisation", () => {
    // A pack is a vocabulary anyone could adopt. One named for its author's own project is a
    // private artifact that happens to live here, and it teaches new readers the wrong thing.
    for (const name of packDirs()) {
      for (const word of CONSUMER_WORDS) {
        assert.ok(!name.toLowerCase().includes(word), `pack "${name}" is named for a consumer`);
      }
    }
  });

  test("every pack declares a name, version and engine range", () => {
    for (const name of packDirs()) {
      const manifest = join(PACKS, name, "pack.yml");
      const pack = parseYaml(readFileSync(manifest, "utf8"));
      assert.equal(pack.name, name, `packs/${name}: name disagrees with its folder`);
      assert.match(String(pack.version ?? ""), /^\d+\.\d+\.\d+$/, `packs/${name}: needs a semver version`);
      assert.ok(pack.requires, `packs/${name}: needs \`requires:\` (engine range)`);
    }
  });

  test("every shape module is registered", () => {
    // The defect this exists to prevent: a shape module that no view spec can reach, because
    // nothing imported it into the registry.
    const helpers = new Set(["index.js", "sql.js"]);
    const modules = readdirSync(join(SRC, "shapes"))
      .filter((f) => f.endsWith(".js") && !helpers.has(f))
      .map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(modules.sort(), Object.keys(SHAPES).sort());
  });

  test("SHAPES.md documents exactly the registered shapes", () => {
    // Docs drift is the failure gitdata exists to catch; the tool holds itself to it.
    const documented = readFileSync(join(REPO, "SHAPES.md"), "utf8")
      .split("\n")
      .map((line) => /^\|\s*`(\w+)`\s*\|/.exec(line)?.[1])
      .filter(Boolean);
    assert.deepEqual(documented.sort(), Object.keys(SHAPES).sort());
  });

  test("docs/DOCTOR.md documents exactly the registered checks", () => {
    // Same ratchet as SHAPES.md above, for the same reason. A check id is a PUBLIC name: a
    // consumer writes it into their own policy file to lower a severity, so an id that no
    // document explains is one they can only discover by reading our source — and a documented
    // id the engine does not register is a suppression that silently does nothing.
    const documented = readFileSync(join(REPO, "docs/DOCTOR.md"), "utf8")
      .split("\n")
      .map((line) => /^\|\s*`(GD\d{3})`\s*\|/.exec(line)?.[1])
      .filter(Boolean);
    assert.deepEqual(documented.sort(), CHECKS.map((c) => c.id).sort());
  });

  test("every check's default severity is documented, and every id is unique", () => {
    // The default level is half of what the id means: "lowering requires a reason" is only
    // legible if a reader can see what it is being lowered FROM.
    const doc = readFileSync(join(REPO, "docs/DOCTOR.md"), "utf8");
    const seen = new Set();
    for (const check of CHECKS) {
      assert.ok(!seen.has(check.id), `duplicate check id ${check.id}`);
      seen.add(check.id);
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${check.id}\` |`));
      assert.ok(row, `docs/DOCTOR.md has no catalog row for ${check.id}`);
      assert.match(
        row,
        new RegExp(`\\|\\s*${check.name}\\s*\\|\\s*${check.level}\\s*\\|`),
        `docs/DOCTOR.md row for ${check.id} disagrees with the registry (${check.name}, ${check.level})`,
      );
    }
  });

  test("bundled pack views declare shapes, not SQL", () => {
    // A shipped pack is a worked example. If one needs raw SQL to say what it means, a shape is
    // missing — and SHAPES.md's claim about the packs goes stale the moment this stops holding.
    for (const name of packDirs()) {
      const viewsDir = join(PACKS, name, "files", "data", "_views");
      if (!existsSync(viewsDir)) continue;
      for (const file of readdirSync(viewsDir).filter((f) => f.endsWith(".view.yml"))) {
        const spec = parseYaml(readFileSync(join(viewsDir, file), "utf8"));
        for (const [queryName, q] of Object.entries(spec.queries ?? {})) {
          const at = `packs/${name}/${file}: query "${queryName}"`;
          assert.notEqual(typeof q, "string", `${at} is raw SQL — declare a shape`);
          assert.ok(q && typeof q === "object", `${at} must be a shape declaration`);
          assert.ok(
            Object.hasOwn(SHAPES, q.shape),
            `${at} declares unregistered shape "${q.shape}" — available: ${Object.keys(SHAPES).join(", ")}`,
          );
        }
      }
    }
  });

  test("every manifest path points at a file that ships", () => {
    // `exports: { ".": "./src/index.js" }` sat in the manifest for four commits while the file
    // did not exist, and nothing caught it: the CLI enters through `bin`, so the import path was
    // never exercised and `npm pack` happily built a tarball around a dangling pointer.
    //
    // Existence is only half of it. A target can exist and still not ship, if `files` omits it.
    const m = manifest();
    const shipped = new Set(m.files ?? []);

    // Every optional field is optional: removing `module` or `bin` is a legitimate manifest edit
    // and must report as a normal assertion, not a TypeError from Object.entries(undefined).
    const targets = [];
    const add = (field, target) => {
      if (typeof target === "string") return void targets.push([field, target]);
      if (target && typeof target === "object") {
        // Conditions nest arbitrarily deep; walk rather than assuming one level.
        for (const [k, v] of Object.entries(target)) add(`${field}.${k}`, v);
      }
    };
    for (const field of ["main", "module", "types"]) if (m[field]) add(field, m[field]);
    for (const [n, p] of Object.entries(m.bin ?? {})) add(`bin.${n}`, p);
    for (const [sub, t] of Object.entries(m.exports ?? {})) add(`exports["${sub}"]`, t);

    for (const [field, target] of targets) {
      const rel = target.replace(/^\.\//, "");
      assert.ok(existsSync(join(REPO, rel)), `package.json ${field} -> ${target} does not exist`);
      assert.ok(
        shipped.has(rel.split("/")[0]) || shipped.has(rel) || rel === "package.json",
        `package.json ${field} -> ${target} is not covered by "files" and would not ship`,
      );
    }
  });

  test("every export subpath is reachable from both ESM and CJS", () => {
    // Statting a target is not resolving a subpath. `{"banana": "./src/index.js"}` points at a
    // real, shipped file and resolves for no runtime on earth — existence checks pass it, the
    // tarball builds, the install succeeds, and the first `import` fails at the consumer.
    //
    // Node matches ["node", "import", "default"] for import and ["node", "require", "default"]
    // for require. A subpath reachable by one and not the other is a narrowing: dropping
    // `default` for a lone `import` is exactly how this package stopped answering require().
    const ESM = new Set(["node", "import", "default"]);
    const CJS = new Set(["node", "require", "default"]);

    const reachable = (target, conditions) => {
      if (typeof target === "string") return true; // a bare string IS the default condition
      if (!target || typeof target !== "object") return false;
      return Object.entries(target).some(
        ([cond, next]) => conditions.has(cond) && reachable(next, conditions),
      );
    };

    for (const [sub, target] of Object.entries(manifest().exports ?? {})) {
      const declared = typeof target === "object" && target ? Object.keys(target).join(", ") : target;
      assert.ok(
        reachable(target, ESM),
        `exports["${sub}"] is unreachable from ESM (conditions: ${declared}) — needs "import", "node" or "default"`,
      );
      assert.ok(
        reachable(target, CJS),
        `exports["${sub}"] is unreachable from CJS (conditions: ${declared}) — needs "require", "node" or "default"`,
      );
    }
  });

  test("a consumer can import and require the package by name", () => {
    // The end of the argument: link the package into a throwaway node_modules and make Node
    // itself answer, through the real resolver, from outside the repo. Anything short of this
    // is a reading of the manifest, and a reading is what shipped the narrowing.
    const m = manifest();
    const dir = mkdtempSync(join(tmpdir(), "gitdata-resolve-"));
    try {
      const [scope, bare] = m.name.startsWith("@") ? m.name.split("/") : [null, m.name];
      const parent = scope ? join(dir, "node_modules", scope) : join(dir, "node_modules");
      mkdirSync(parent, { recursive: true });
      symlinkSync(REPO, join(parent, bare), "dir");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));

      const subpaths = Object.keys(m.exports ?? {}).map((k) => (k === "." ? m.name : m.name + k.slice(1)));
      writeFileSync(
        join(dir, "probe.mjs"),
        // Exits 0 whatever it finds, reporting on stdout: execFileSync throws away output on a
        // non-zero exit, and a guard whose failure message is "Command failed" helps nobody.
        `import { createRequire } from "node:module";
         const require = createRequire(import.meta.url);
         const fail = (m) => console.log("FAIL " + m);
         for (const s of ${JSON.stringify(subpaths)}) {
           let url;
           try { url = await import.meta.resolve(s); } catch (e) { fail(s + " esm-resolve " + (e.code ?? e.message)); }
           try { require.resolve(s); } catch (e) { fail(s + " cjs-resolve " + (e.code ?? e.message)); }
           // A JSON subpath is data, not a module: loading it needs an import attribute, which is
           // the caller's syntax, not something the manifest can be wrong about.
           const opts = url && url.endsWith(".json") ? { with: { type: "json" } } : undefined;
           try { await import(s, opts); } catch (e) { fail(s + " import " + (e.code ?? e.message)); }
           try { require(s); } catch (e) {
             // require() of ESM is unsupported below Node 22.12 — that is the runtime's limit,
             // not the manifest turning the caller away. Only an exports refusal is our bug.
             if (e.code !== "ERR_REQUIRE_ESM") fail(s + " require " + (e.code ?? e.message));
           }
           console.log("checked " + s);
         }
         console.log("PROBE DONE");`,
      );

      const out = execFileSync(process.execPath, [join(dir, "probe.mjs")], {
        encoding: "utf8",
        cwd: dir,
        timeout: 60_000,
      });
      assert.match(out, /PROBE DONE/, `probe did not run to completion:\n${out}`);
      assert.equal(
        out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"),
        "",
        `a consumer could not load every subpath:\n${out}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing we ship names the unscoped package", () => {
    // Unscoped, `gitdata` on npm is an unrelated 2016 package by another author. A file telling
    // a consumer to fetch that name is us instructing somebody else's machine to download and
    // execute a stranger's code.
    //
    // Enumerating runners is whack-a-mole, and the first version of this guard lost: it knew
    // npx/bunx/pnpm-dlx and missed `npm exec`, `deno run npm:`, and — the one with real teeth —
    // a dependency block. `init` copies a pack's whole `files/` tree (the `installs:` key is
    // documentation it never reads), so a `files/package.json` lands in the consumer's repo root
    // and their next install fetches it.
    //
    // So the rule is inverted: extract whatever token sits in package position, whatever the
    // syntax, and fail only when it names the package we must never send anyone to. Unrelated
    // tools and prose are ignored by construction, which is what keeps `npx -y`, a pinned
    // `pkg@1.2.3`, and a bare `npm install` from being false positives.
    const m = manifest();
    const FORBIDDEN = (n) => n === "gitdata" || n.startsWith("@gitdata/");

    // A specifier that is not an npm registry name cannot resolve to the squatted package.
    // `npx github:marktiderman/gitdata` is a git spec and is correct — it must not trip this.
    const NON_REGISTRY = /^(?:github|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link|workspace|portal):/i;

    /** A command-line token, or a manifest key, reduced to the npm package name it names. */
    const packageName = (raw) => {
      let s = raw.replace(/^[('"`]+|[)'"`,;]+$/g, "").trim();
      if (!s || s.startsWith("-")) return null;
      if (s.startsWith("npm:")) s = s.slice(4); // deno, and npm: aliases in dependency values
      if (NON_REGISTRY.test(s)) return null;
      const at = s.indexOf("@", s.startsWith("@") ? 1 : 0); // strip a pinned version
      return (at > 0 ? s.slice(0, at) : s) || null;
    };

    const args = (tail) =>
      tail
        .split(/\s+/)
        .filter((t) => t && t !== "--" && !t.startsWith("-"))
        .map(packageName)
        .filter(Boolean);

    // Tails stop at the newline: `\s+` crossing one is how a bare `npm install` on its own line
    // captured the next line's first word.
    const RUNNER =
      /\b(?:npm\s+exec|npm\s+x|pnpm\s+dlx|pnpm\s+exec|yarn\s+dlx|yarn\s+exec|deno\s+run|bun\s+x|npx|bunx|yarn)\b([^\n`]*)/g;
    const INSTALL =
      /\b(?:npm\s+install|npm\s+add|npm\s+i|pnpm\s+install|pnpm\s+add|pnpm\s+i|yarn\s+add|bun\s+install|bun\s+add|deno\s+add)\b([^\n`]*)/g;
    const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;
    const DEP_BLOCKS = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "resolutions",
      "overrides",
    ];

    const walk = (p) =>
      statSync(p).isDirectory() ? readdirSync(p).flatMap((e) => walk(join(p, e))) : [p];

    // Guard the whole shipped surface, not just packs/ — README.md is in the tarball and was the
    // one file the previous guard could not see. Derived from `files` so it tracks the manifest,
    // plus the contributor docs, which stay guarded even after being dropped from the tarball.
    const roots = [...new Set([...(m.files ?? []), "README.md", "docs", "CONTRIBUTING.md", "CLAUDE.md"])];

    for (const root of roots) {
      if (!existsSync(join(REPO, root))) continue;
      for (const file of walk(join(REPO, root))) {
        const at = file.slice(REPO.length + 1);
        const raw = readFileSync(file);
        if (raw.includes(0)) continue; // binary
        const text = raw.toString("utf8");
        const offend = (kind, n) =>
          assert.fail(`${at} ${kind} the unscoped "${n}" — must be "${m.name}"`);

        for (const [, tail] of text.matchAll(RUNNER)) {
          const first = args(tail)[0];
          if (first && FORBIDDEN(first)) offend("runs", first);
        }
        for (const [, tail] of text.matchAll(INSTALL)) {
          for (const n of args(tail)) if (FORBIDDEN(n)) offend("installs", n);
        }
        for (const [, , spec] of text.matchAll(SPECIFIER)) {
          const n = packageName(spec);
          if (n && FORBIDDEN(n)) offend("imports", n);
        }
        if (!file.endsWith(".json")) continue;
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          continue; // not our problem to diagnose here
        }
        for (const block of DEP_BLOCKS) {
          for (const [dep, range] of Object.entries(json?.[block] ?? {})) {
            if (FORBIDDEN(dep)) offend(`declares a ${block} on`, dep);
            const aliased = typeof range === "string" ? packageName(range) : null;
            if (aliased && FORBIDDEN(aliased)) offend(`aliases a ${block} to`, aliased);
          }
        }
      }
    }
  });

  test("packs depend on the engine, never the reverse", () => {
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(REPO.length + 1);
      // init.js legitimately reads packs/ from disk; nothing may *import* from one.
      assert.ok(
        !/(?:from|import|require)\s*\(?\s*["'][^"']*\/packs\//.test(text),
        `${rel} imports from packs/`,
      );
    }
  });
});
