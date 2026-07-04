# How Turnleaf works

Architecture notes for contributors and the curious. If you just want to
*use* the tool, the [README](README.md) is the place — this document explains
how the machine is built and why it's built that way.

---

## The one big idea: never decompile, never recompile

The converter's core promise is that **every conversion produces a jar that
loads**. That promise is kept *by construction*: the main pipeline edits the
plugin's compiled bytecode directly and never round-trips through source code.
No decompile → edit → recompile means no compile step that can fail — not on
obfuscated plugins, not on Kotlin-compiled plugins, not on weird compiler
output.

A decompiler (Vineflower) is still in the project, but only where a human or
an AI needs to *read* code: the "What changed?" diff viewer and the AI
features. It is never in the path that produces your converted jar.

**Honest scope:** "loads without scheduler exceptions" is guaranteed;
"every feature behaves identically under multithreading" is what the rest of
the pipeline (analysis, shims, boot testing) works toward and what your test
server confirms.

## The pipeline, in plain words

Every conversion runs the same stages:

1. **Index** — a small Java engine reads every class, method, and call site in
   the jar and hands a JSON summary to the TypeScript side.
2. **Scan** — the summary is matched against two rule sets: a hand-written
   catalog (scheduler APIs, teleports, `isPrimaryThread`, …) and a large
   generated catalog mined from Folia itself (see below). Result: a list of
   every call that would break.
3. **Rewrite** — each breaking call site is redirected to a **safety layer**
   injected into the jar (details below), and `folia-supported: true` is added
   to `plugin.yml`.
4. **Thread-safety fixes** — Folia runs plugin code on many threads at once,
   so the analyzer traces which fields are touched from multiple scheduling
   contexts and upgrades collections to thread-safe ones — but only where the
   swap is provably safe. Everything it can't prove is reported instead of
   silently changed.
5. **Re-check** — the finished jar is re-indexed and re-scanned exactly like
   the input. The report states how many problems remain (the goal, and the
   norm on the test corpus, is zero).
6. **Stamp** — a manifest inside the jar records the converter version, a hash
   of the rule/shim pipeline, and the original jar's identity. That's how the
   app knows a jar was converted by an older version and offers re-conversion.

Optional stages: the **AI fix** for shared state that can't be fixed
mechanically, the **AI repair loop** for actual crashes, and the **boot test**
(start a real Folia server with the converted jar and read its log).

## The safety layer (the injected "shim")

The rewrite doesn't delete broken calls — it reroutes them through a small
Java runtime injected into the converted jar and relocated to a per-plugin
package so two converted plugins never clash.

- Scheduler calls (`BukkitScheduler`, `BukkitRunnable`, …) land on a facade
  backed by [FoliaLib](https://github.com/TechnicallyCoded/FoliaLib), which
  maps them onto Folia's region/entity/async schedulers — and still works on
  plain Paper, so a converted jar runs on both.
- Entity/block/world calls get an **ownership gate**: at runtime the shim
  checks "does the current thread own this thing's region?" If yes, the call
  runs inline (near-zero overhead — already-correct code stays fast). If no,
  it's handed to the thread that owns the region, which is what Folia demands.

## Where the rules come from

Hand-maintained rules live in `src/rules/catalog.json` — small, readable,
data-driven (behavior changes never require touching Java).

The interesting part is the **generated catalog**: the `mine-folia` command
parses the actual Folia server jar, finds every API method protected by
Folia's own thread-ownership guards, and maps them back to the Bukkit API.
That currently yields ~1,160 region-locked methods, from which ~625 shim
methods are generated automatically (plus a subtype map so a method declared
on a supertype still matches calls through subtypes). When Folia changes,
re-mine and the whole pipeline updates.

## Why there's Java in a TypeScript project

Everything you'd want to read or change is TypeScript: the CLI, the GUI, the
pipeline, the analyzers, the AI layer, the rules. Java survives in exactly two
places where it's physically unavoidable:

1. **`shim-runtime/`** — this code executes inside the Minecraft server's JVM,
   so it must be Java no matter what the tool is written in.
2. **`engine/`** — bytecode surgery needs ASM, the only production-grade
   library that can rewrite modern class files (the deal-breaker for every
   non-JVM alternative is recomputing stack-map frames after editing method
   bodies; ASM does it, nothing else does reliably). The engine is
   deliberately dumb machinery: it receives JSON job specs ("index this jar",
   "apply these redirects"), does them, and returns JSON. All *decisions* live
   on the TypeScript side.

The engine runs as a **daemon** — the JVM starts once per session and takes
jobs as newline-delimited JSON over stdin, so JVM startup is paid once and the
JIT warms up across a batch. Bytecode never crosses the process boundary
(jars are read/written on disk); JSON carries only job specs and summaries.

## The AI layer

Two AI features share one design:

- **AI Fix** targets shared-state problems the mechanical fixer couldn't
  prove safe: it decompiles just the affected classes, asks the model for
  minimal patches, and stages the result as a separate jar.
- **AI Repair** starts from a crash: it parses the stack trace (Paper
  helpfully embeds the owning jar's name in every frame), decompiles only the
  classes involved, asks for a fix, and — in boot mode — re-boots the server
  and repeats until clean.

Design decisions that matter:

- **Any provider works.** Everything speaks the OpenAI-compatible chat
  dialect, so DeepSeek (default), OpenAI, Anthropic, Cerebras, or any custom
  endpoint is a config entry, not an integration. The provider is
  auto-detected from the API key where the prefix is unambiguous.
- **The patch protocol is model-agnostic**: the model must respond with JSON
  search/replace edits copied character-for-character from the provided
  source. No provider-specific function calling, so cheap models work.
- **Safety is mechanical, not trust.** Every proposed patch must compile
  (`javac` against the original jar + the Paper API), pass a re-scan, and
  survive verification before it lands. A bad model just means fewer accepted
  patches — never a broken jar. Rejected patches leave the class in its
  mechanically-converted state.
- **AI strength** (Quick / Standard / Deep) scales how many targets are
  attempted, how many retries each gets, and how ambitious the prompts are —
  Deep is allowed to restructure code properly instead of minimal patching.
- **Privacy**: anything that leaves the machine (crash excerpts in prompts,
  prefilled GitHub issues) is scrubbed of UUIDs, IPs, player names, and
  home-directory usernames first.

## Verification

- **Re-scan**: every converted jar is re-indexed and re-scanned; remaining
  problems are counted in the report.
- **Boot harness**: `verify` launches the real Folia jar headlessly with the
  converted plugin(s) installed, waits for ready, and triages the log —
  plugin-scoped errors fail the verdict, unrelated server noise doesn't.
- **Unit tests**: `npm test` covers the pure logic (crash-trace parsing, the
  privacy scrubber, the diff engine, provider resolution, version and
  manifest parsing). CI runs them before every build.
- **Corpus**: real plugins that have been converted and boot-verified are
  listed in [COMPATIBILITY.md](COMPATIBILITY.md).

## Repository layout

```
folia-on-demand/
├── src/                    TypeScript — everything you'd normally touch
│   ├── cli.ts                 command-line entry (scan/convert/verify/ai/repair/migrate/gui)
│   ├── convert/               the rewrite pipeline, manifest, server migration
│   ├── scan/ + src/rules/     rule matching + the rule catalogs
│   ├── analyze/               shared-state and region-ownership analysis
│   ├── ai/                    providers, patch protocol, AI fix + repair loop
│   ├── verify/                headless Folia boot harness
│   ├── gui/                   local web server + the app's frontend
│   └── util/                  scrubbing, diffing, version helpers
├── engine/                 Java — ASM bytecode indexer/transformer (daemon)
├── shim-runtime/           Java — the safety layer injected into converted jars
├── src-tauri/              Rust — thin desktop shell around the local server
├── scripts/                fetch-tools, esbuild bundle, app staging
├── .github/workflows/      3-OS release build (Windows / Linux / macOS)
├── tests/                  plugin corpus + probe-plugin regression fixture
└── tools/, folia/, out/…   fetched tools and working dirs (gitignored)
```

## Building and releasing

Dev setup is three commands: `npm install`, `node scripts/fetch-tools.mjs`
(downloads Vineflower and generates the compile classpath — `tools/` is
gitignored), `mvn package` (builds the two Java modules). Then `npm run cli
-- gui` for the dashboard or `npm run app` for the desktop shell.

The desktop app is packaged self-contained: `scripts/stage.mjs` bundles the
whole TypeScript side into one file (no `node_modules` at runtime) and stages
it with the engine, shims, rules, and compile classpath; Tauri wraps that as
an installer. End users need only Node.js and Java.

Releases are built by CI: push a `vX.Y.Z` tag (matching `package.json` —
a guard fails the build otherwise) and GitHub Actions produces the Windows
installer, Linux deb + AppImage, and macOS dmg, attached to the release
automatically. Version bumps touch `package.json`, `src-tauri/tauri.conf.json`,
and `src-tauri/Cargo.toml`.

## Reference material

- `resources/FoliaLib` — the scheduler facade the shim embeds; start with
  `PlatformScheduler` and the Folia implementation.
- Folia docs (docs.papermc.io → Folia) — the region-threading contract and
  the four scheduler types.
- `COMPATIBILITY.md` — what's been proven to convert and boot.
