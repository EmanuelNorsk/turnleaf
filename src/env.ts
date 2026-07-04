import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of all app resources and working data.
 *
 * In development this resolves to the project root (from this file's location).
 * In a packaged build the Tauri launcher sets FOD_HOME to a writable app home
 * that mirrors the same directory layout, so every path below is identical in
 * both modes — the code never needs to know whether it's bundled or in-tree.
 */
export const ROOT = process.env.FOD_HOME
  ? path.resolve(process.env.FOD_HOME)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Read-only resources (bundled with the app).
export const ENGINE_JAR = path.join(ROOT, "engine", "target", "engine.jar");
export const SHIM_JAR = path.join(ROOT, "shim-runtime", "target", "shim-runtime.jar");
export const VINEFLOWER_JAR = path.join(ROOT, "tools", "vineflower.jar");
export const PAPER_CLASSPATH_FILE = path.join(ROOT, "tools", "paper-classpath.txt");
export const RULES_DIR = path.join(ROOT, "src", "rules");
export const PUBLIC_DIR = path.join(ROOT, "src", "gui", "public");

// User-writable working directories.
export const FOLIA_DIR = path.join(ROOT, "folia");
export const OUT_DIR = path.join(ROOT, "out");
export const REPORTS_DIR = path.join(ROOT, "reports");
export const UPLOADS_DIR = path.join(ROOT, "uploads");
export const TOOLS_DIR = path.join(ROOT, "tools");

/**
 * Entries of tools/paper-classpath.txt as absolute paths. Dev builds store
 * absolute .m2 paths (kept as-is by path.resolve); the staged app ships the
 * jars inside tools/ with entries relative to it.
 */
export function readPaperClasspath(): string[] {
  return fs
    .readFileSync(PAPER_CLASSPATH_FILE, "utf8")
    .trim()
    .split(path.delimiter)
    .filter((e) => e.length > 0)
    .map((e) => path.resolve(TOOLS_DIR, e));
}

// Baked in by scripts/bundle.mjs (esbuild define); undeclared when running
// from source via tsx, so only touch them through typeof guards.
declare const __FOD_PKG_VERSION__: string | undefined;
declare const __FOD_PKG_REPO__: string | undefined;

function devPkg(): { version?: string; repository?: unknown } | null {
  const p = path.join(ROOT, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Normalize package.json "repository" forms to an "owner/name" GitHub slug. */
function repoSlug(repository: unknown): string | null {
  const raw = typeof repository === "string" ? repository : (repository as { url?: string })?.url ?? "";
  const m = raw.match(/github(?:\.com)?[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/** The running app version (baked into the bundle; package.json in dev). */
export const VERSION =
  (typeof __FOD_PKG_VERSION__ === "string" && __FOD_PKG_VERSION__) || devPkg()?.version || "0.0.0";

/**
 * GitHub "owner/name" to poll for new releases, or null to disable the update
 * check (e.g. while the project has no GitHub remote yet). FOD_UPDATE_REPO
 * overrides for testing.
 */
export const UPDATE_REPO =
  process.env.FOD_UPDATE_REPO ||
  (typeof __FOD_PKG_REPO__ === "string" && __FOD_PKG_REPO__) ||
  repoSlug(devPkg()?.repository) ||
  null;

/** Path to the bundled single-file build, set by the packaged launcher. */
export const BUNDLE = process.env.FOD_BUNDLE;

/**
 * argv (after the node executable) needed to re-invoke this CLI with a new
 * subcommand — used when the GUI server spawns a job as a child process.
 * Packaged: run the bundled file. Dev: run the TypeScript entry via tsx.
 */
export function selfCommand(): string[] {
  if (BUNDLE) return [BUNDLE];
  return [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "cli.ts")];
}
