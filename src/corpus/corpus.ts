import fs from "node:fs";
import path from "node:path";
import { convert } from "../convert/convert.js";
import { jarMetas } from "../engine/client.js";
import { parsePluginMeta } from "../scan/scanner.js";
import { bootWithPlugins } from "../verify/harness.js";
import { FOLIA_DIR, REPORTS_DIR, VERSION } from "../env.js";
import type { PluginMeta } from "../types.js";

/**
 * Corpus runner: pull the most-downloaded Paper/Spigot plugins from Modrinth,
 * convert every one, boot-test them on the local Folia server in batches, and
 * emit ready-to-paste COMPATIBILITY.md rows.
 *
 * Modrinth is used because it has a public API with direct CDN downloads and
 * permits automated access with a descriptive User-Agent. Jars land in a
 * gitignored folder and are never redistributed — only names/results are.
 */

const UA = { "User-Agent": `turnleaf/${VERSION} (github.com/EmanuelNorsk/turnleaf; corpus tester)` };
const API = "https://api.modrinth.com/v2";

export interface CorpusOptions {
  count: number;
  dir: string;
  boot: boolean;
  batchSize: number;
}

interface CorpusPlugin {
  slug: string;
  title: string;
  downloads: number;
  versionNumber?: string;
  file?: string; // absolute path of the downloaded jar
  meta?: PluginMeta | null;
  native?: boolean; // folia-ready as shipped — no conversion needed
  convertedJar?: string;
  blockersBefore?: number;
  blockersAfter?: number;
  regionRisks?: number;
  status:
    | "pending"
    | "native"
    | "not-a-plugin"
    | "download-failed"
    | "convert-failed"
    | "converted"
    | "boot-pass"
    | "boot-issues"
    | "boot-fail"
    | "untestable";
  note: string;
}

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Modrinth ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function searchTopPlugins(count: number): Promise<CorpusPlugin[]> {
  const out: CorpusPlugin[] = [];
  const facets = encodeURIComponent('[["project_type:plugin"],["categories:paper","categories:spigot","categories:bukkit"]]');
  for (let offset = 0; out.length < count; offset += 100) {
    const page = await apiJson<{ hits: { slug: string; title: string; downloads: number }[] }>(
      `${API}/search?limit=${Math.min(100, count - out.length)}&offset=${offset}&index=downloads&facets=${facets}`,
    );
    if (page.hits.length === 0) break;
    for (const h of page.hits) {
      out.push({ slug: h.slug, title: h.title, downloads: h.downloads, status: "pending", note: "" });
    }
  }
  return out.slice(0, count);
}

async function downloadLatest(p: CorpusPlugin, dir: string): Promise<void> {
  const versions = await apiJson<
    { version_number: string; loaders: string[]; files: { url: string; filename: string; primary: boolean }[] }[]
  >(`${API}/project/${p.slug}/version?loaders=${encodeURIComponent('["paper","spigot","bukkit","folia"]')}`);
  const latest = versions[0];
  if (!latest) {
    p.status = "download-failed";
    p.note = "no bukkit/paper version on Modrinth";
    return;
  }
  p.versionNumber = latest.version_number;
  if (latest.loaders.includes("folia")) {
    p.status = "native";
    p.note = "ships native Folia support — no conversion needed";
    return;
  }
  const file = latest.files.find((f) => f.primary && f.filename.endsWith(".jar")) ?? latest.files.find((f) => f.filename.endsWith(".jar"));
  if (!file) {
    p.status = "download-failed";
    p.note = "latest version has no .jar file";
    return;
  }
  const dest = path.join(dir, file.filename);
  if (!fs.existsSync(dest)) {
    const res = await fetch(file.url, { headers: UA, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      p.status = "download-failed";
      p.note = `download HTTP ${res.status}`;
      return;
    }
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  p.file = dest;
}

/** Group plugins so hard-dependency clusters boot together, then pack into batches. */
function packBatches(plugins: CorpusPlugin[], batchSize: number): CorpusPlugin[][] {
  const byName = new Map<string, CorpusPlugin>();
  for (const p of plugins) if (p.meta?.name) byName.set(p.meta.name, p);

  // union-find over hard-dep edges inside the corpus
  const parent = new Map<CorpusPlugin, CorpusPlugin>();
  const find = (x: CorpusPlugin): CorpusPlugin => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const p of plugins) {
    for (const dep of p.meta?.depend ?? []) {
      const target = byName.get(dep);
      if (target) parent.set(find(p), find(target));
    }
  }
  const clusters = new Map<CorpusPlugin, CorpusPlugin[]>();
  for (const p of plugins) {
    const root = find(p);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(p);
  }
  // first-fit packing (a cluster larger than batchSize becomes its own batch)
  const batches: CorpusPlugin[][] = [];
  for (const cluster of [...clusters.values()].sort((a, b) => b.length - a.length)) {
    const home = batches.find((b) => b.length + cluster.length <= batchSize);
    if (home) home.push(...cluster);
    else batches.push([...cluster]);
  }
  return batches;
}

async function bootBatch(batch: CorpusPlugin[]): Promise<void> {
  const jars = batch.map((p) => p.convertedJar!);
  const names = batch.map((p) => p.meta?.name ?? path.basename(p.convertedJar!, ".jar"));
  const scopes = batch.map((p) => p.meta?.main?.slice(0, p.meta.main.lastIndexOf("."))).filter((s): s is string => Boolean(s));
  const result = await bootWithPlugins(jars, names, { expectMarkers: [], pluginScopes: scopes, timeoutSeconds: 480 });

  for (const [i, p] of batch.entries()) {
    const name = names[i];
    const jarBase = path.basename(p.convertedJar!);
    const mine = result.fatalIssues.filter((f) => f.includes(jarBase) || f.includes(name));
    if (!result.reachedDone) {
      p.status = "boot-fail";
      p.note = "server never reached ready state in this batch";
    } else if (result.missingPlugins.includes(name)) {
      p.status = "boot-fail";
      p.note = mine[0]?.slice(0, 160) ?? "did not enable";
    } else if (mine.length > 0) {
      p.status = "boot-issues";
      p.note = mine[0].slice(0, 160);
    } else {
      p.status = "boot-pass";
      p.note = `${p.blockersBefore} blocker(s) → ${p.blockersAfter}`;
    }
  }
}

const ROW_ICON: Record<string, string> = {
  "boot-pass": "✅ clean",
  "boot-issues": "🟡 boots with errors",
  "boot-fail": "❌ failed to boot",
  converted: "⚪ converted (not boot-tested)",
  "convert-failed": "❌ converter error",
  untestable: "⚪ converted (untestable here)",
};

export async function runCorpus(options: CorpusOptions): Promise<void> {
  const dir = path.resolve(options.dir);
  fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(dir, "converted");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Fetching top ${options.count} Paper/Spigot plugins from Modrinth…`);
  const plugins = await searchTopPlugins(options.count);

  // 1. Download (skipping native-Folia releases).
  for (const [i, p] of plugins.entries()) {
    process.stdout.write(`[${i + 1}/${plugins.length}] ${p.title} … `);
    try {
      await downloadLatest(p, dir);
      console.log(p.status === "pending" ? path.basename(p.file!) : p.note);
    } catch (e) {
      p.status = "download-failed";
      p.note = e instanceof Error ? e.message : String(e);
      console.log(`download failed: ${p.note}`);
    }
  }

  // 2. Metadata (plugin.yml) for the downloaded ones.
  const downloaded = plugins.filter((p) => p.status === "pending");
  if (downloaded.length > 0) {
    const metas = await jarMetas(downloaded.map((p) => p.file!));
    for (const [i, p] of downloaded.entries()) {
      p.meta = parsePluginMeta(metas[i].pluginYml);
      if (!p.meta) {
        p.status = "not-a-plugin";
        p.note = "no plugin.yml in the jar";
      } else if (p.meta.foliaSupported) {
        p.status = "native";
        p.note = "plugin.yml already declares folia-supported";
      }
    }
  }

  // 3. Convert.
  const toConvert = plugins.filter((p) => p.status === "pending");
  console.log(`\nConverting ${toConvert.length} plugin(s)…`);
  for (const [i, p] of toConvert.entries()) {
    process.stdout.write(`[${i + 1}/${toConvert.length}] ${p.title} … `);
    try {
      const outJar = path.join(outDir, `${path.basename(p.file!, ".jar")}-folia.jar`);
      const outcome = await convert(p.file!, { outJar });
      p.convertedJar = outcome.outputJar;
      p.blockersBefore = outcome.preScan.findings.filter((f) => f.severity === "blocker").length;
      p.blockersAfter = outcome.postScan.findings.filter((f) => f.severity === "blocker").length;
      p.regionRisks = outcome.regionViolations.filter((v) => v.mutation).length;
      p.status = "converted";
      p.note = `${p.blockersBefore} blocker(s) → ${p.blockersAfter}`;
      console.log(p.note + (p.regionRisks ? `, ${p.regionRisks} region risk(s)` : ""));
    } catch (e) {
      p.status = "convert-failed";
      p.note = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      console.log(`FAILED: ${p.note}`);
    }
  }

  // 4. Boot-test in dependency-aware batches.
  const serverJar = fs.existsSync(FOLIA_DIR) && fs.readdirSync(FOLIA_DIR).some((f) => f.endsWith(".jar"));
  if (options.boot && serverJar) {
    const converted = plugins.filter((p) => p.status === "converted");
    const corpusNames = new Set(converted.map((p) => p.meta?.name).filter(Boolean));
    const bootable: CorpusPlugin[] = [];
    for (const p of converted) {
      const unmet = (p.meta?.depend ?? []).filter((d) => !corpusNames.has(d));
      if (unmet.length > 0) {
        p.status = "untestable";
        p.note = `requires ${unmet.join(", ")} (not in this corpus run)`;
      } else {
        bootable.push(p);
      }
    }
    const batches = packBatches(bootable, options.batchSize);
    console.log(`\nBoot-testing ${bootable.length} plugin(s) in ${batches.length} batch(es) of ≤${options.batchSize}…`);
    for (const [i, batch] of batches.entries()) {
      console.log(`\nBatch ${i + 1}/${batches.length}: ${batch.map((p) => p.title).join(", ")}`);
      await bootBatch(batch);
      // A batch that never reached ready state is inconclusive — isolate by
      // booting each member solo so one bad plugin can't smear the others.
      if (batch.some((p) => p.status === "boot-fail" && p.note.includes("never reached"))) {
        console.log("  batch inconclusive — retrying each plugin solo…");
        for (const p of batch) await bootBatch([p]);
      }
      for (const p of batch) console.log(`  ${ROW_ICON[p.status] ?? p.status}  ${p.title} — ${p.note}`);
    }
  } else if (options.boot) {
    console.log("\nNo Folia server jar in folia/ — skipping boot tests (results marked not boot-tested).");
  }

  // 5. Emit results: JSON + ready-to-paste COMPATIBILITY.md rows.
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, "corpus-results.json"), JSON.stringify(plugins, null, 2));

  const rows: string[] = [];
  for (const p of [...plugins].sort((a, b) => a.title.localeCompare(b.title))) {
    if (p.status === "native" || p.status === "not-a-plugin" || p.status === "download-failed") continue;
    const result = ROW_ICON[p.status] ?? p.status;
    rows.push(`| ${p.title} | ${p.versionNumber ?? "?"} | ${result} | ${p.note.replaceAll("|", "/")} |`);
  }
  const natives = plugins.filter((p) => p.status === "native").map((p) => p.title);
  const md = [
    `<!-- generated by \`turnleaf corpus\` on ${new Date().toISOString().slice(0, 10)} (turnleaf ${VERSION}) -->`,
    "| Plugin | Version tested | Result | Notes |",
    "|---|---|---|---|",
    ...rows,
    "",
    natives.length ? `Native Folia support (no conversion needed): ${natives.join(", ")}` : "",
  ].join("\n");
  const mdFile = path.join(REPORTS_DIR, "corpus-results.md");
  fs.writeFileSync(mdFile, md);

  const tally = new Map<string, number>();
  for (const p of plugins) tally.set(p.status, (tally.get(p.status) ?? 0) + 1);
  console.log(`\nCorpus summary: ${[...tally.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}`);
  console.log(`Rows for COMPATIBILITY.md: ${mdFile}`);
}
