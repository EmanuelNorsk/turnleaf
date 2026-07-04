# Contributing

Thanks for helping make more plugins run on Folia. The three most useful
contributions, easiest first:

## 1. Report what you converted

Every compatibility data point helps the next person. Open a
[compatibility report](../../issues/new?template=compatibility-report.yml)
(clean conversions are as valuable as broken ones) — confirmed rows land in
[COMPATIBILITY.md](COMPATIBILITY.md).

## 2. Report crashes and converter gaps

The fastest way is from inside the app: analyze the crash log (or use live
**Watch**), then hit **Report** — it prefills the issue and scrubs private
data. Manual reports: use the
[crash template](../../issues/new?template=crash-report.yml).

A crash tagged *region-thread-violation* on a freshly converted jar is the
most valuable report of all — it usually means Folia region-locks an API we
don't shim yet, and one new shim fixes it for every plugin at once.

## 3. Code

Dev setup (Windows/Linux/macOS — you need Node 20+, JDK 21+, Maven):

```sh
npm install                    # TypeScript side
node scripts/fetch-tools.mjs   # decompiler + compile classpath (tools/ is gitignored)
mvn package                    # the two Java modules (engine + shim runtime)
```

Run it: `npm run cli -- gui` (dashboard in the browser) or `npm run app`
(desktop shell, needs Rust). Architecture tour: [PLAN.md](PLAN.md).

Before a PR:

```sh
npx tsc --noEmit   # typecheck
npm test           # unit tests
```

If you touched the engine, shims, or rules, also convert a couple of plugins
and check the report still ends with `blockers after: 0` — and ideally boot
them (`npm run cli -- verify out/YourPlugin-folia.jar`, needs a Folia jar in
`folia/`).

House rules:

- **Never commit plugin jars.** `tests/*.jar` and `out/` are gitignored on
  purpose — many test plugins are paid. Bring your own jars locally.
- Rules and behavior live on the TypeScript side (`src/rules/`, `src/`);
  the Java engine stays dumb machinery. If a fix seems to need engine
  changes, mention it in the issue first.
- License is GPL-3.0 — contributions land under the same license.
