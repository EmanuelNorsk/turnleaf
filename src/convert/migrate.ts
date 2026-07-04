import fs from "node:fs";
import path from "node:path";
import { jarMetas } from "../engine/client.js";
import { parsePluginMeta } from "../scan/scanner.js";
import { convert } from "./convert.js";
import { parseStamp, pipelineHash } from "./pipeline.js";

/**
 * Migrate a whole server to Folia: classify every jar in its plugins folder,
 * back the originals up once, and convert in place keeping filenames (so
 * configs, update scripts, and permissions keep working untouched).
 *
 * Safe to re-run any time: already-current conversions are skipped, stale ones
 * are re-converted from the backed-up original, natively folia-supported
 * plugins are left alone.
 */

export const BACKUP_DIR_NAME = "pre-folia-backup";

export type MigrateStatus =
  | "converted" // converted in this run
  | "reconverted" // was stale, refreshed in this run
  | "already-current" // converted by this pipeline version — nothing to do
  | "folia-ready" // plugin natively supports Folia
  | "not-a-plugin" // no plugin.yml (library jar etc.)
  | "failed";

export interface MigrateEntry {
  file: string;
  plugin: string | null;
  status: MigrateStatus;
  detail: string;
  blockersBefore?: number;
  blockersAfter?: number;
}

export interface MigrateResult {
  pluginsDir: string;
  backupDir: string;
  entries: MigrateEntry[];
}

/** serverDir may be the server root (containing plugins/) or the plugins folder itself. */
export function resolvePluginsDir(serverDir: string): string {
  const abs = path.resolve(serverDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  if (path.basename(abs).toLowerCase() === "plugins") return abs;
  const nested = path.join(abs, "plugins");
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) return nested;
  if (fs.readdirSync(abs).some((f) => f.endsWith(".jar"))) return abs;
  throw new Error(`No plugins folder found under ${abs} (and it contains no jars itself).`);
}

export async function migrateServer(serverDir: string, options: { t2?: boolean } = {}): Promise<MigrateResult> {
  const pluginsDir = resolvePluginsDir(serverDir);
  const backupDir = path.join(pluginsDir, BACKUP_DIR_NAME);
  const jarFiles = fs
    .readdirSync(pluginsDir)
    .filter((f) => f.endsWith(".jar"))
    .sort();
  if (jarFiles.length === 0) throw new Error(`No plugin jars in ${pluginsDir}`);

  console.log(`Migrating ${jarFiles.length} jar(s) in ${pluginsDir}`);
  console.log(`Originals are kept in ${backupDir}\n`);

  const metas = await jarMetas(jarFiles.map((f) => path.join(pluginsDir, f)));
  const currentHash = pipelineHash();
  const entries: MigrateEntry[] = [];

  for (const [i, file] of jarFiles.entries()) {
    const jarPath = path.join(pluginsDir, file);
    const meta = parsePluginMeta(metas[i].pluginYml);
    const stamp = parseStamp(metas[i].properties);
    const label = `[${i + 1}/${jarFiles.length}] ${file}`;

    if (!meta) {
      entries.push({ file, plugin: null, status: "not-a-plugin", detail: "no plugin.yml — left untouched" });
      console.log(`${label} — not a plugin, skipped`);
      continue;
    }
    if (stamp && stamp["pipeline-hash"] === currentHash) {
      entries.push({ file, plugin: meta.name ?? null, status: "already-current", detail: `converted with ${stamp["converter-version"] ?? "this version"}` });
      console.log(`${label} — already converted by this version, skipped`);
      continue;
    }
    if (!stamp && meta.foliaSupported) {
      entries.push({ file, plugin: meta.name ?? null, status: "folia-ready", detail: "plugin natively supports Folia — left untouched" });
      console.log(`${label} — natively folia-supported, skipped`);
      continue;
    }

    // Needs (re)conversion. Prefer the backed-up original as input for stale
    // jars; otherwise the jar itself (our conversion is idempotent by design,
    // but the true original gives the cleanest result).
    const wasStale = stamp !== null;
    const backupOriginal = path.join(backupDir, stamp?.["original-name"] ?? file);
    const input = wasStale && fs.existsSync(backupOriginal) ? backupOriginal : jarPath;

    // One-time backup of anything we're about to overwrite in place.
    fs.mkdirSync(backupDir, { recursive: true });
    const backupTarget = path.join(backupDir, file);
    if (!wasStale && !fs.existsSync(backupTarget)) fs.copyFileSync(jarPath, backupTarget);

    console.log(`${label} — converting${wasStale ? " (outdated conversion)" : ""}…`);
    try {
      const tmpOut = path.join(pluginsDir, `.${file}.converting`);
      const outcome = await convert(input, { outJar: tmpOut, t2: options.t2 });
      fs.renameSync(tmpOut, jarPath); // atomic-ish in-place swap, same filename
      const before = outcome.preScan.findings.filter((f) => f.severity === "blocker").length;
      const after = outcome.postScan.findings.filter((f) => f.severity === "blocker").length;
      entries.push({
        file,
        plugin: meta.name ?? null,
        status: wasStale ? "reconverted" : "converted",
        detail: `${before} blocker(s) → ${after}`,
        blockersBefore: before,
        blockersAfter: after,
      });
      console.log(`    ✔ ${before} blocker(s) → ${after}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      entries.push({ file, plugin: meta.name ?? null, status: "failed", detail });
      console.log(`    ✖ failed: ${detail} (original left in place)`);
      fs.rmSync(path.join(pluginsDir, `.${file}.converting`), { force: true });
    }
  }

  return { pluginsDir, backupDir, entries };
}
