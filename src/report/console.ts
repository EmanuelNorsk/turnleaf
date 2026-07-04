import fs from "node:fs";
import path from "node:path";
import type { ConvertOutcome, Finding, ScanResult, Severity } from "../types.js";
import { REPORTS_DIR } from "../env.js";

const SEVERITY_ORDER: Severity[] = ["blocker", "warning", "review"];
const SEVERITY_ICON: Record<Severity, string> = {
  blocker: "✖",
  warning: "▲",
  review: "•",
};

const dots = (internalName: string) => internalName.replaceAll("/", ".");

export function printScanReport(result: ScanResult, elapsedMs: number): void {
  const p = result.plugin;
  console.log("");
  console.log(`Plugin   ${p?.name ?? "(no plugin.yml)"} ${p?.version ?? ""}`.trimEnd());
  if (p?.main) console.log(`Main     ${p.main}`);
  console.log(`Folia    ${p?.foliaSupported ? "already flagged folia-supported ✔" : "not folia-supported (Tier 1 will add the flag)"}`);
  console.log(
    `Scanned  ${result.classCount} classes, ${result.methodCount} methods, ${result.invocationCount} call sites in ${(elapsedMs / 1000).toFixed(1)}s`,
  );

  if (result.findings.length === 0) {
    console.log("\nNo Folia incompatibilities found by the current rule catalog.");
    return;
  }

  // Group by rule.
  const byRule = new Map<string, Finding[]>();
  for (const f of result.findings) {
    (byRule.get(f.ruleId) ?? byRule.set(f.ruleId, []).get(f.ruleId)!).push(f);
  }

  const sorted = [...byRule.entries()].sort(
    ([, a], [, b]) =>
      SEVERITY_ORDER.indexOf(a[0].severity) - SEVERITY_ORDER.indexOf(b[0].severity) || b.length - a.length,
  );

  console.log(`\nFindings (${result.findings.length} total)`);
  for (const [ruleId, findings] of sorted) {
    const { severity, title } = findings[0];
    console.log(`\n  ${SEVERITY_ICON[severity]} [${severity}] ${title} — ${findings.length}× (${ruleId})`);
    const shown = findings.slice(0, 5);
    for (const f of shown) {
      const methodName = f.method.slice(0, f.method.indexOf("("));
      console.log(`      ${dots(f.className)}#${methodName} → ${dots(f.invocation.owner)}.${f.invocation.name}`);
    }
    if (findings.length > shown.length) {
      console.log(`      … and ${findings.length - shown.length} more`);
    }
  }

  if (result.engineWarnings.length > 0) {
    console.log(`\nEngine warnings (${result.engineWarnings.length}):`);
    for (const w of result.engineWarnings.slice(0, 5)) console.log(`  ${w}`);
  }
}

export function printConvertReport(outcome: ConvertOutcome, elapsedMs: number): void {
  const { preScan, postScan, result } = outcome;
  const blockers = (s: ScanResult) => s.findings.filter((f) => f.severity === "blocker");

  console.log("");
  console.log(`Plugin     ${preScan.plugin?.name ?? "(unknown)"} ${preScan.plugin?.version ?? ""}`.trimEnd());
  console.log(`Output     ${outcome.outputJar}`);
  console.log(`Shim at    ${outcome.targetPrefix.replaceAll("/", ".")} (${result.injectedClasses} classes injected)`);
  console.log(`plugin.yml ${result.pluginYmlPatched ? "folia-supported: true added ✔" : "already flagged / not patched"}`);

  const totalRewrites = Object.values(result.rewrites).reduce((a, b) => a + b, 0);
  console.log(`\nRewritten call sites (${totalRewrites} total across ${result.classesModified} classes):`);
  const sorted = Object.entries(result.rewrites).sort(([, a], [, b]) => b - a);
  for (const [id, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}×  ${id}`);
  }
  if (totalRewrites === 0) console.log("  (none matched)");

  const fixes = result.concurrencyFixes.filter((f) => f.sites > 0);
  const unfixed = result.concurrencyFixes.filter((f) => f.sites === 0 && f.unmatchedWrites > 0);
  if (fixes.length > 0 || unfixed.length > 0 || outcome.tier3Targets.length > 0) {
    console.log(`\nTier 2 concurrency fixes:`);
    for (const f of fixes) {
      const partial = f.unmatchedWrites > 0 ? `  (${f.unmatchedWrites} site(s) unmatched — see report)` : "";
      console.log(`  ✔ ${f.field.replaceAll("/", ".")} → ${f.strategy} at ${f.sites} site(s)${partial}`);
    }
    for (const f of unfixed) {
      console.log(`  ⚠ ${f.field.replaceAll("/", ".")} — no safely-rewritable allocation found (Tier 3)`);
    }
    for (const f of outcome.tier3Targets) {
      console.log(`  ⚠ ${f.owner.replaceAll("/", ".")}.${f.field} (${f.desc.slice(1, -1).replaceAll("/", ".")}) — concrete-typed, retyping needs Tier 3 (run: cli ai)`);
    }
  }

  if (outcome.regionViolations.length > 0) {
    console.log(`\n⚠ Region-lock risks (${outcome.regionViolations.length}) — NOT auto-fixed; these mutate an entity/block from a thread that won't own its region and will throw on Folia:`);
    for (const v of outcome.regionViolations.slice(0, 10)) {
      const where = `${v.className.replaceAll("/", ".")}#${v.method.slice(0, v.method.indexOf("("))}`;
      const call = `${v.call.owner.slice(v.call.owner.lastIndexOf("/") + 1)}.${v.call.name}`;
      console.log(`    [${v.contexts.join(",")}] ${where} → ${call}`);
    }
    if (outcome.regionViolations.length > 10) console.log(`    … and ${outcome.regionViolations.length - 10} more (see report / run: cli analyze)`);
    console.log(`    These need the entity/region scheduler — candidates for a shim entry or Tier 3.`);
  }

  const remaining = blockers(postScan);
  console.log(`\nVerification (re-index + re-scan of output):`);
  console.log(`  blockers before: ${blockers(preScan).length}   blockers after: ${remaining.length}`);
  if (remaining.length > 0) {
    console.log("  ⚠ UNHANDLED call sites (need Tier 2/3 or a new shim method):");
    for (const f of remaining.slice(0, 10)) {
      console.log(`    ${f.className.replaceAll("/", ".")} → ${f.invocation.owner.replaceAll("/", ".")}.${f.invocation.name}${f.invocation.desc}`);
    }
  } else {
    console.log("  ✔ no scheduler-API blockers remain");
  }

  if (result.strippedEntries.length > 0) {
    console.log(`\nStripped jar-signing metadata: ${result.strippedEntries.join(", ")}`);
  }
  for (const w of [...result.warnings, ...outcome.skippedShimMethods.map((s) => `shim method skipped: ${s}`)]) {
    console.log(`  note: ${w}`);
  }
  console.log(`\nDone in ${(elapsedMs / 1000).toFixed(1)}s`);
}

export function printBootReport(result: import("../verify/harness.js").BootResult): void {
  console.log("");
  console.log(`Server     ${result.reachedDone ? `reached "Done" ✔` : "NEVER reached ready state ✖"} (${result.bootSeconds.toFixed(0)}s, exit code ${result.exitCode})`);
  for (const n of result.enabledPlugins) console.log(`Plugin     ${n}: enabled ✔`);
  for (const n of result.missingPlugins) console.log(`Plugin     ${n}: NOT enabled ✖`);
  if (result.markersFound.length > 0 || result.markersMissing.length > 0) {
    console.log(`Markers    ${result.markersFound.length}/${result.markersFound.length + result.markersMissing.length} found`);
    for (const m of result.markersFound) console.log(`  ✔ ${m}`);
    for (const m of result.markersMissing) console.log(`  ✖ MISSING: ${m}`);
  }
  if (result.fatalIssues.length > 0) {
    console.log(`\nPlugin-scoped problems (${result.fatalIssues.length}) — these fail the verdict:`);
    for (const i of result.fatalIssues.slice(0, 15)) console.log(`  ✖ ${i.length > 160 ? i.slice(0, 160) + "…" : i}`);
    if (result.fatalIssues.length > 15) console.log(`  … and ${result.fatalIssues.length - 15} more (see log)`);
  }
  if (result.noise.length > 0) {
    console.log(`\nUnrelated server noise (${result.noise.length}, not failing):`);
    for (const i of result.noise.slice(0, 5)) console.log(`  · ${i.length > 160 ? i.slice(0, 160) + "…" : i}`);
    if (result.noise.length > 5) console.log(`  … and ${result.noise.length - 5} more (see log)`);
  }
  console.log(`\nVerdict    ${result.ok ? "PASS ✔" : "FAIL ✖"}`);
  console.log(`Full log   ${result.logFile}`);
}

export function printAnalysisReport(result: import("../analyze/sharedState.js").AnalysisResult, elapsedMs: number): void {
  const high = result.findings.filter((f) => f.risk === "high");
  const medium = result.findings.filter((f) => f.risk === "medium");
  const low = result.findings.filter((f) => f.risk === "low");

  console.log("");
  console.log(`Analyzed   ${result.methodsWithContext} methods reachable from concurrent contexts in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Findings   ${high.length} high, ${medium.length} medium, ${low.length} low (read-only / single-context)`);

  const rv = result.regionViolations;
  const mutations = rv.filter((v) => v.mutation);
  const reads = rv.filter((v) => !v.mutation);
  if (rv.length > 0) {
    console.log(`\nRegion-lock violations — region-locked API called from a thread that won't own the entity/block:`);
    console.log(`  ${mutations.length} mutations (will throw on Folia), ${reads.length} reads (lower risk)`);
    for (const v of mutations.slice(0, 15)) {
      const where = `${v.className.replaceAll("/", ".")}#${v.method.slice(0, v.method.indexOf("("))}`;
      const call = `${v.call.owner.slice(v.call.owner.lastIndexOf("/") + 1)}.${v.call.name}`;
      console.log(`  ✖ [${v.contexts.join(",")}] ${where} → ${call}`);
    }
    if (mutations.length > 15) console.log(`  … and ${mutations.length - 15} more mutations (see JSON report)`);
    if (mutations.length === 0) console.log(`  (no mutations — only lower-risk reads; see JSON report)`);
  }

  if (high.length === 0 && medium.length === 0 && rv.length === 0) {
    console.log("\nNo mutable shared state or region-lock violations detected.");
    return;
  }

  for (const f of high.slice(0, 15)) {
    const type = f.desc.slice(1, -1).replaceAll("/", ".");
    console.log(`\n  ✖ [high] ${f.owner.replaceAll("/", ".")}.${f.field}`);
    console.log(`      type ${type}${f.isStatic ? "  (static)" : ""}${f.isVolatile ? "  (volatile)" : ""}`);
    console.log(`      contexts ${f.contexts.join(" + ")}   reads ${f.reads}, writes ${f.writes}`);
    for (const s of f.sampleSites.slice(0, 3)) console.log(`        ${s.replaceAll("/", ".")}`);
    console.log(`      → ${f.suggestion}`);
  }
  if (high.length > 15) console.log(`\n  … and ${high.length - 15} more high-risk fields (see JSON report)`);
  if (medium.length > 0) {
    console.log(`\n  ▲ ${medium.length} medium-risk fields (interface-typed or non-collection mutables) — see JSON report`);
  }
}

export function writeJsonReport(
  outFile: string,
  result: ScanResult | ConvertOutcome | import("../analyze/sharedState.js").AnalysisResult,
): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
}

export function defaultReportPath(jarPath: string): string {
  const base = path.basename(jarPath, ".jar");
  return path.join(REPORTS_DIR, `${base}.scan.json`);
}
