import { Command } from "commander";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { REPORTS_DIR, ROOT, VERSION, readPaperClasspath } from "./env.js";

dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
dotenv.config({ quiet: true });
import { analyzeSharedState } from "./analyze/sharedState.js";
import { convert } from "./convert/convert.js";
import { indexJar, mineFolia } from "./engine/client.js";
import { loadCatalog, parsePluginMeta, scan } from "./scan/scanner.js";
import { bootWithPlugins } from "./verify/harness.js";
import { defaultReportPath, printAnalysisReport, printBootReport, printConvertReport, printScanReport, writeJsonReport } from "./report/console.js";

const program = new Command();

program
  .name("turnleaf")
  .description("Turn Paper plugins into Folia-compatible plugins")
  .version(VERSION);

program
  .command("scan")
  .description("Scan a plugin jar for Folia incompatibilities (pipeline stages A+B)")
  .argument("<jar>", "path to the plugin .jar")
  .option("--json <file>", "path for the full JSON report")
  .action(async (jar: string, opts: { json?: string }) => {
    const jarPath = path.resolve(jar);
    if (!fs.existsSync(jarPath)) {
      console.error(`No such file: ${jarPath}`);
      process.exit(1);
    }
    const started = Date.now();
    const index = await indexJar(jarPath);
    const result = scan(index, loadCatalog());
    printScanReport(result, Date.now() - started);

    const out = opts.json ?? defaultReportPath(jarPath);
    writeJsonReport(out, result);
    console.log(`\nFull report: ${out}`);
  });

program
  .command("convert")
  .description("Convert plugin jar(s) into Folia-compatible jars (Tier 1 + Tier 2, stages A–E)")
  .argument("<jars...>", "path(s) to plugin .jar files")
  .option("-o, --out <file>", "output jar path (single input only)")
  .option("--out-dir <dir>", "output folder for the converted jars (default: out/)")
  .option("--no-t2", "skip Tier 2 concurrency fixes")
  .action(async (jars: string[], opts: { out?: string; outDir?: string; t2: boolean }) => {
    const jarPaths = jars.map((j) => path.resolve(j));
    for (const p of jarPaths) {
      if (!fs.existsSync(p)) {
        console.error(`No such file: ${p}`);
        process.exit(1);
      }
    }
    if (opts.out && jarPaths.length > 1) {
      console.error("--out is for a single jar; use --out-dir for multiple.");
      process.exit(1);
    }
    let failed = 0;
    for (const [i, jarPath] of jarPaths.entries()) {
      if (jarPaths.length > 1) console.log(`\n===== [${i + 1}/${jarPaths.length}] ${path.basename(jarPath)} =====`);
      try {
        const outJar =
          opts.out ?? (opts.outDir ? path.join(path.resolve(opts.outDir), `${path.basename(jarPath, ".jar")}-folia.jar`) : undefined);
        const started = Date.now();
        const outcome = await convert(jarPath, { outJar, t2: opts.t2 });
        printConvertReport(outcome, Date.now() - started);

        const reportFile = path.join(REPORTS_DIR, `${path.basename(jarPath, ".jar")}.convert.json`);
        writeJsonReport(reportFile, outcome);
        console.log(`Full report: ${reportFile}`);
      } catch (e) {
        failed++;
        console.error(`✖ ${path.basename(jarPath)} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (failed > 0) process.exit(1);
  });

program
  .command("verify")
  .description("Boot the local Folia server with plugin jars and analyze the log (stage D, dynamic)")
  .argument("<jars...>", "plugin jars to install and boot together")
  .option("--expect <markers...>", "log lines that must appear for a PASS")
  .option("--timeout <seconds>", "max seconds to wait for server ready", "420")
  .action(async (jars: string[], opts: { expect?: string[]; timeout: string }) => {
    const jarPaths = jars.map((j) => path.resolve(j));
    for (const p of jarPaths) {
      if (!fs.existsSync(p)) {
        console.error(`No such file: ${p}`);
        process.exit(1);
      }
    }
    const names: string[] = [];
    const scopes: string[] = [];
    for (const p of jarPaths) {
      const meta = parsePluginMeta((await indexJar(p)).pluginYml);
      names.push(meta?.name ?? path.basename(p, ".jar"));
      if (meta?.main) scopes.push(meta.main.slice(0, meta.main.lastIndexOf(".")));
    }
    console.log(`Booting Folia with ${names.join(" + ")} (first boot generates the world — this can take a few minutes)…`);
    const result = await bootWithPlugins(jarPaths, names, {
      expectMarkers: opts.expect ?? [],
      pluginScopes: scopes,
      timeoutSeconds: Number(opts.timeout),
    });
    printBootReport(result);
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("analyze")
  .description("Tier 2 (detector): find mutable state shared across Folia's concurrent contexts")
  .argument("<jar>", "path to the plugin .jar")
  .action(async (jar: string) => {
    const jarPath = path.resolve(jar);
    if (!fs.existsSync(jarPath)) {
      console.error(`No such file: ${jarPath}`);
      process.exit(1);
    }
    const started = Date.now();
    const index = await indexJar(jarPath);
    const result = analyzeSharedState(index);
    printAnalysisReport(result, Date.now() - started);

    const reportFile = path.join(REPORTS_DIR, `${path.basename(jarPath, ".jar")}.analysis.json`);
    writeJsonReport(reportFile, result);
    console.log(`\nFull report: ${reportFile}`);
  });

program
  .command("ai")
  .description("Tier 3: AI-assisted rewrites for fields Tier 2 could not fix (decompile → patch → compile gate)")
  .argument("<jar>", "path to the ORIGINAL plugin .jar (conversion runs first)")
  .option("--limit <n>", "max Tier 3 targets to attempt (default: from strength)")
  .option("--model <model>", "model id (default: from AI settings)")
  .option("--strength <level>", "quick | standard | deep (default: from AI settings)")
  .option("--libs <jars...>", "extra dependency jars for the compile gate")
  .action(async (jar: string, opts: { limit?: string; model?: string; strength?: string; libs?: string[] }) => {
    const jarPath = path.resolve(jar);
    if (!fs.existsSync(jarPath)) {
      console.error(`No such file: ${jarPath}`);
      process.exit(1);
    }
    const { runTier3 } = await import("./ai/tier3.js");
    const started = Date.now();
    const t3 = await runTier3(jarPath, {
      limit: opts.limit ? Number(opts.limit) : undefined,
      model: opts.model,
      strength: opts.strength as "quick" | "standard" | "deep" | undefined,
      libs: opts.libs,
    });

    console.log(`\nTier 3 summary (${((Date.now() - started) / 1000).toFixed(0)}s):`);
    for (const r of t3.results) {
      const icon = r.status === "patched" ? "✔" : r.status === "skipped" ? "•" : "✖";
      console.log(`  ${icon} [${r.status}] ${r.field} — ${r.detail}`);
    }
    if (t3.finalJar) {
      console.log(`\nStaged Tier 3 artifact: ${t3.finalJar}`);
      console.log(`(Tier 1+2 jar unchanged at ${t3.outcome.outputJar} — verify the T3 jar before adopting it)`);
    }
    const reportFile = path.join(REPORTS_DIR, `${path.basename(jarPath, ".jar")}.tier3.json`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify({ results: t3.results, finalJar: t3.finalJar }, null, 2));
    console.log(`Full report: ${reportFile}`);
  });

program
  .command("repair")
  .description("Self-repair: fix crashes from a log (or a live boot test) with AI patches behind the compile gate")
  .argument("<jar>", "the CONVERTED plugin jar that crashed")
  .option("--log <file>", "crash log / stack trace file (e.g. from your server)")
  .option("--boot", "boot on the local Folia server to find crashes, repair, and re-verify")
  .option("--with <jars...>", "extra plugin jars to install alongside when booting (dependencies)")
  .option("--strength <level>", "quick | standard | deep (default: from AI settings)")
  .option("--model <model>", "model id (default: from AI settings)")
  .option("--limit <n>", "max crash incidents per pass (default: from strength)")
  .action(async (jar: string, opts: { log?: string; boot?: boolean; with?: string[]; strength?: string; model?: string; limit?: string }) => {
    const jarPath = path.resolve(jar);
    if (!fs.existsSync(jarPath)) {
      console.error(`No such file: ${jarPath}`);
      process.exit(1);
    }
    if (!opts.log && !opts.boot) {
      console.error("Provide --log <file> or --boot (how should I find the crash?).");
      process.exit(1);
    }
    const { runRepair } = await import("./ai/repair.js");
    const started = Date.now();
    const outcome = await runRepair(jarPath, {
      logFile: opts.log ? path.resolve(opts.log) : undefined,
      boot: opts.boot,
      withJars: (opts.with ?? []).map((w) => path.resolve(w)),
      strength: opts.strength as "quick" | "standard" | "deep" | undefined,
      model: opts.model,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });

    console.log(`\nRepair summary (${((Date.now() - started) / 1000).toFixed(0)}s):`);
    for (const [i, pass] of outcome.passes.entries()) {
      console.log(`  pass ${i + 1}: ${pass.incidents} incident(s)`);
      for (const r of pass.results) {
        const icon = r.status === "patched" ? "✔" : r.status === "skipped" ? "•" : "✖";
        console.log(`    ${icon} [${r.status}] ${r.header.slice(0, 100)}${r.notes ? ` — ${r.notes}` : ""}`);
      }
    }
    if (outcome.repairedJar) {
      console.log(`\nRepaired jar: ${outcome.repairedJar}`);
      if (outcome.finalBootOk !== undefined) {
        console.log(`Verification boot: ${outcome.finalBootOk ? "PASS ✔" : "still failing — see log above"}`);
      } else {
        console.log("Test it on your server; the original jar is untouched.");
      }
    } else {
      console.log("\nNo patches landed — the jar is unchanged.");
    }
    const reportFile = path.join(REPORTS_DIR, `${path.basename(jarPath, ".jar")}.repair.json`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(outcome, null, 2));
    console.log(`Full report: ${reportFile}`);
    process.exit(outcome.repairedJar ? 0 : 1);
  });

program
  .command("migrate")
  .description("Migrate a whole server to Folia: convert every plugin in its plugins/ folder in place (originals backed up)")
  .argument("<serverDir>", "server root (containing plugins/) or the plugins folder itself")
  .option("--no-t2", "skip Tier 2 concurrency fixes")
  .action(async (serverDir: string, opts: { t2: boolean }) => {
    const { migrateServer } = await import("./convert/migrate.js");
    const started = Date.now();
    const result = await migrateServer(serverDir, { t2: opts.t2 });

    const by = (s: string) => result.entries.filter((e) => e.status === s);
    const converted = [...by("converted"), ...by("reconverted")];
    const failed = by("failed");
    console.log(`\nMigration summary (${((Date.now() - started) / 1000).toFixed(0)}s):`);
    console.log(`  ${converted.length} converted (${by("reconverted").length} were outdated re-conversions)`);
    console.log(`  ${by("already-current").length} already converted and current`);
    console.log(`  ${by("folia-ready").length} natively Folia-ready`);
    console.log(`  ${by("not-a-plugin").length} non-plugin jar(s) left untouched`);
    if (failed.length > 0) {
      console.log(`  ✖ ${failed.length} FAILED (originals left in place):`);
      for (const f of failed) console.log(`      ${f.file} — ${f.detail.slice(0, 140)}`);
    }
    const unclean = converted.filter((e) => (e.blockersAfter ?? 0) > 0);
    if (unclean.length > 0) {
      console.log(`  ⚠ ${unclean.length} converted with remaining blockers — check their reports`);
    }
    console.log(`\nOriginals: ${result.backupDir}`);

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const reportFile = path.join(REPORTS_DIR, "migrate-latest.json");
    fs.writeFileSync(reportFile, JSON.stringify(result, null, 2));
    console.log(`Full report: ${reportFile}`);
    process.exit(failed.length > 0 ? 1 : 0);
  });

program
  .command("batch")
  .description("Convert every plugin jar in a directory (skips already-converted *-folia*.jar)")
  .argument("<dir>", "directory containing plugin jars")
  .option("--no-t2", "skip Tier 2 concurrency fixes")
  .action(async (dir: string, opts: { t2: boolean }) => {
    const dirPath = path.resolve(dir);
    const jars = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith(".jar") && !/-folia(-t3)?\.jar$/.test(f))
      .map((f) => path.join(dirPath, f));
    if (jars.length === 0) {
      console.error(`No plugin jars found in ${dirPath}`);
      process.exit(1);
    }
    console.log(`Batch converting ${jars.length} jar(s) from ${dirPath}\n`);
    const started = Date.now();
    let failed = 0;
    for (const jar of jars) {
      const name = path.basename(jar);
      try {
        const t0 = Date.now();
        const outcome = await convert(jar, { t2: opts.t2 });
        const rewrites = Object.values(outcome.result.rewrites).reduce((a, b) => a + b, 0);
        const fixes = outcome.result.concurrencyFixes.filter((f) => f.sites > 0).length;
        const remaining = outcome.postScan.findings.filter((f) => f.severity === "blocker").length;
        const status = remaining === 0 ? "✔" : `⚠ ${remaining} unhandled`;
        console.log(
          `${status}  ${name}  — ${rewrites} rewrites, ${fixes} T2 fixes, ${outcome.tier3Targets.length} T3 targets (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
        );
      } catch (e) {
        failed++;
        console.log(`✖  ${name} — ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`\nDone: ${jars.length - failed}/${jars.length} converted in ${((Date.now() - started) / 1000).toFixed(1)}s → out/`);
  });

program
  .command("mine-folia")
  .description("Mine the Folia server jar for region-locked API methods (regenerates the region catalog)")
  .option("--depth <n>", "call-graph search depth", "1")
  .action(async (opts: { depth: string }) => {
    const root = ROOT;
    // The real server classes are extracted by a boot; locate them + the API jar.
    const versionsDir = path.join(root, "folia", "work", "versions");
    const libsDir = path.join(root, "folia", "work", "libraries");
    const findJar = (dir: string, match: (f: string) => boolean): string | null => {
      if (!fs.existsSync(dir)) return null;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop()!;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile() && e.name.endsWith(".jar") && match(e.name)) return p;
        }
      }
      return null;
    };
    const serverJar = findJar(versionsDir, (f) => /folia|paper/.test(f));
    const apiJar = findJar(libsDir, (f) => /^folia-api-|^paper-api-/.test(f));
    if (!serverJar || !apiJar) {
      console.error(
        "Could not find the extracted server jar and API jar under folia/work/.\n" +
          "Run a boot first (e.g. `cli verify <a converted jar>`) — the server extracts them on first launch.",
      );
      process.exit(1);
    }
    console.log(`Mining ${path.basename(serverJar)} + ${path.basename(apiJar)} (depth ${opts.depth})…`);
    const result = await mineFolia([serverJar, apiJar], Number(opts.depth));
    const catalog = {
      version: 1,
      generatedFrom: path.basename(serverJar, ".jar"),
      generatedAt: new Date().toISOString(),
      methods: result.api.map((m) => ({ prefix: m.ownerPrefix, name: m.name, desc: m.desc })),
    };
    const out = path.join(root, "src", "rules", "region-guarded.generated.json");
    fs.writeFileSync(out, JSON.stringify(catalog, null, 0));
    console.log(
      `Found ${result.api.length} region-locked API methods (${result.directGuardCallers} guard call sites, ${result.craftMethodsReached} CraftBukkit methods reached).`,
    );
    console.log(`Region catalog written: ${path.relative(root, out)}`);

    // Generate ShimGenerated.java: a shim method per entity mutator, filtered
    // to methods present in the paper-api we compile against.
    const paperApiJar = readPaperClasspath().find((p) => path.basename(p).startsWith("paper-api"));
    if (!paperApiJar) {
      console.error("paper-api jar not found in tools/paper-classpath.txt — skipping shim generation.");
      return;
    }
    const { generateShim } = await import("./convert/generateShim.js");
    const paperApi = await indexJar(paperApiJar);
    const gen = generateShim(result, paperApi);
    const genOut = path.join(root, "shim-runtime", "src", "main", "java", "dev", "foliaondemand", "shim", "ShimGenerated.java");
    fs.writeFileSync(genOut, gen.source);
    console.log(`Generated ${gen.count} entity-mutator shims (${gen.skipped} skipped — not in the compiled paper-api).`);
    console.log(`Shim source written: ${path.relative(root, genOut)}  → rebuild with: mvn package`);

    // Subtype map: each Bukkit interface → all its sub-interfaces. Lets a shim
    // whose method is declared on a supertype (e.g. AbstractArrow.setPickupStatus)
    // also match subtype call sites (Arrow). Disjoint per method → collision-free.
    const directSupers = new Map<string, string[]>(paperApi.classes.map((c) => [c.name, c.interfaces]));
    const collectSupers = (name: string, acc: Set<string>): void => {
      for (const s of directSupers.get(name) ?? []) if (acc.add(s)) collectSupers(s, acc);
    };
    const subtypes: Record<string, string[]> = {};
    for (const c of paperApi.classes) {
      if (!c.name.startsWith("org/bukkit/")) continue;
      const supers = new Set<string>();
      collectSupers(c.name, supers);
      for (const s of supers) {
        if (!s.startsWith("org/bukkit/")) continue;
        (subtypes[s] ??= []).push(c.name);
      }
    }
    const subOut = path.join(root, "src", "rules", "region-subtypes.generated.json");
    fs.writeFileSync(subOut, JSON.stringify(subtypes, null, 0));
    console.log(`Subtype map written: ${path.relative(root, subOut)} (${Object.keys(subtypes).length} types)`);
  });

program
  .command("gui")
  .description("Start the local web dashboard")
  .option("--port <port>", "port to listen on", "4646")
  .option("--no-open", "do not open the browser automatically")
  .action(async (opts: { port: string; open: boolean }) => {
    const { startGui } = await import("./gui/server.js");
    await startGui(Number(opts.port), opts.open);
  });

program
  .parseAsync()
  .then(async () => {
    const { shutdownEngine } = await import("./engine/client.js");
    // The GUI command keeps its own long-lived process; everything else
    // should let the node process exit once the command finishes.
    if (!process.argv.includes("gui")) shutdownEngine();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
