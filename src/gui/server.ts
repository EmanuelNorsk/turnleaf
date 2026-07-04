import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  ENGINE_JAR,
  FOLIA_DIR,
  OUT_DIR,
  PUBLIC_DIR,
  REPORTS_DIR,
  ROOT,
  SHIM_JAR,
  TOOLS_DIR,
  UPDATE_REPO,
  UPLOADS_DIR,
  VERSION,
  VINEFLOWER_JAR,
  selfCommand,
} from "../env.js";
import { detectProvider, loadAiSettings, saveAiSettings, type AiSettings } from "../ai/provider.js";
import { parseIncidents } from "../ai/repair.js";
import { decompile } from "../ai/tier3.js";
import { parseStamp, pipelineHash } from "../convert/pipeline.js";
import { unifiedDiff } from "../util/diff.js";
import { scrub } from "../util/scrub.js";
import { isNewer } from "../util/versions.js";
import { extractClasses, jarMetas } from "../engine/client.js";
import { parsePluginMeta } from "../scan/scanner.js";

const DEFAULT_OUT = OUT_DIR;
const ENV_FILE = path.join(ROOT, ".env.local");
const SETUP_MARKER = path.join(ROOT, ".setup-done");

const ACTIONS = new Set(["scan", "convert", "analyze", "ai", "verify", "repair"]);

/** The DeepSeek key as currently saved in the app's .env.local (not the process env). */
function readApiKey(): string | null {
  if (!fs.existsSync(ENV_FILE)) return null;
  const m = fs.readFileSync(ENV_FILE, "utf8").match(/^DEEPSEEK_API_KEY=(.*)$/m);
  const key = m?.[1].trim();
  return key ? key : null;
}

/** Save (or, with an empty key, remove) the DeepSeek key in .env.local. */
function writeApiKey(key: string): void {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const line = key ? `DEEPSEEK_API_KEY=${key}` : "";
  if (/^DEEPSEEK_API_KEY=.*$/m.test(content)) {
    content = content.replace(/^DEEPSEEK_API_KEY=.*(\r?\n)?/m, line ? `${line}\n` : "");
  } else if (line) {
    content = content.trimEnd() + (content.trim() ? "\n" : "") + `${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

function findServerJar(): string | null {
  if (!fs.existsSync(FOLIA_DIR)) return null;
  return fs.readdirSync(FOLIA_DIR).find((f) => f.endsWith(".jar")) ?? null;
}

/** Minecraft version from a server jar name like "folia-26.1.2-8.jar". */
function mcVersionOf(name: string | null): string | null {
  return name?.match(/-(\d+(?:\.\d+)+)/)?.[1] ?? null;
}

/** Which Folia version the region catalog was mined from. */
function catalogMcVersion(): string | null {
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "rules", "region-guarded.generated.json"), "utf8")) as {
      generatedFrom?: string;
    };
    return mcVersionOf(cat.generatedFrom ? `${cat.generatedFrom}.jar` : null);
  } catch {
    return null;
  }
}

// ---- update check (GitHub Releases) ----

interface UpdateInfo {
  current: string;
  latest?: string;
  url?: string;
  hasUpdate: boolean;
  disabled?: boolean;
  error?: string;
}

// ---- crash-log analysis (no AI): attribute each stack trace to the plugin
// jar via the classloader prefix Paper puts in frames, and tag known failure
// shapes with a suggested next step. Shared by /api/analyze-crash and the
// live log watcher. ----

const SERVER_PKGS = [
  "net/minecraft", "org/bukkit", "io/papermc", "com/mojang", "co/aikar",
  "com/destroystokyo", "java/", "jdk/", "sun/", "io/netty", "com/google", "org/spigotmc",
];

export interface AnalyzedIncident {
  header: string;
  jars: string[];
  classes: string[];
  tag: string;
  suggestion: string;
  excerpt: string;
}

function analyzeCrashText(logText: string): AnalyzedIncident[] {
  const incidents = parseIncidents(
    logText,
    (cls, jar) => jar !== null && !SERVER_PKGS.some((p) => cls.startsWith(p)),
  );
  return incidents.map((inc) => {
    const text = inc.excerpt;
    let tag = "other";
    let suggestion = "Not a pattern I recognize — try AI Repair with this log on the plugin's converted jar.";
    if (/UnknownDependencyException|Unknown\/missing dependency/i.test(text)) {
      tag = "missing-dependency";
      suggestion = "The plugin needs another plugin installed. Convert the dependency with this tool and install both.";
    } else if (/ensureTickThread|main thread check|owned by the current region|Detected (?:block|entity|world|chunk) (?:access|modification)|Thread failed/i.test(text)) {
      tag = "region-thread-violation";
      suggestion =
        "An entity/block/world API was called from the wrong region thread — exactly what this converter fixes. Re-convert with the latest version; if it still happens, run AI Repair and report it (it's a converter gap worth a new shim).";
    } else if (/UnsupportedOperationException[\s\S]{0,300}(?:scheduler|BukkitScheduler|getScheduler)/i.test(text)) {
      tag = "scheduler-api";
      suggestion = "The Bukkit scheduler was used unconverted. Make sure this jar went through Convert; if it did, report it — a scheduler call slipped past the rewriter.";
    } else if (/ConcurrentModificationException|ArrayIndexOutOfBoundsException[\s\S]{0,120}HashMap/i.test(text)) {
      tag = "thread-safety";
      suggestion = "Looks like a data race between region threads. Run AI Fix (Tier 3) on the original jar, or AI Repair with this log.";
    } else if (/ClassNotFoundException|NoClassDefFoundError/.test(text)) {
      tag = "missing-class";
      suggestion = "A class doesn't exist at runtime — usually a missing optional dependency, or the plugin doesn't support this Minecraft version.";
    }
    return { header: inc.header, jars: inc.jars, classes: inc.classes, tag, suggestion, excerpt: inc.excerpt };
  });
}

// ---- live log watcher: tail a server's log file, run new content through the
// crash analyzer, and stream incidents to the GUI over SSE. One at a time. ----

interface LogWatch {
  file: string;
  offset: number;
  window: string; // rolling tail of recent text so trace blocks split across reads still parse
  seen: Set<string>;
  timer: NodeJS.Timeout;
  listeners: Set<(event: string, data: unknown) => void>;
  incidents: AnalyzedIncident[];
}

let logWatch: LogWatch | null = null;

function stopLogWatch(): void {
  if (!logWatch) return;
  clearInterval(logWatch.timer);
  for (const l of logWatch.listeners) l("stopped", {});
  logWatch = null;
}

function startLogWatch(file: string): void {
  stopLogWatch();
  const w: LogWatch = {
    file,
    // Start at the end — the user cares about what happens from now on
    // (the analyzer button covers the past).
    offset: fs.existsSync(file) ? fs.statSync(file).size : 0,
    window: "",
    seen: new Set(),
    timer: undefined as unknown as NodeJS.Timeout,
    listeners: new Set(),
    incidents: [],
  };

  const poll = () => {
    try {
      if (!fs.existsSync(w.file)) return;
      const size = fs.statSync(w.file).size;
      if (size < w.offset) w.offset = 0; // log rotated/truncated
      if (size === w.offset) return;
      const fd = fs.openSync(w.file, "r");
      const buf = Buffer.alloc(size - w.offset);
      fs.readSync(fd, buf, 0, buf.length, w.offset);
      fs.closeSync(fd);
      w.offset = size;

      w.window = (w.window + buf.toString("utf8")).slice(-256 * 1024);
      for (const inc of analyzeCrashText(w.window)) {
        const key = `${inc.header.replace(/^\[.*?\]:?\s*/, "")}::${inc.classes[0] ?? ""}`;
        if (w.seen.has(key)) continue;
        w.seen.add(key);
        w.incidents.push(inc);
        for (const l of w.listeners) l("incident", inc);
      }
    } catch {
      // transient read errors (file locked mid-write) — next tick
    }
  };
  w.timer = setInterval(poll, 1000);
  logWatch = w;
}

const UPDATE_CACHE_MS = 6 * 3600 * 1000; // GitHub allows 60 anonymous requests/hour
let updateCache: { at: number; info: UpdateInfo } | null = null;

async function checkForUpdate(force: boolean): Promise<UpdateInfo> {
  if (!UPDATE_REPO) return { current: VERSION, hasUpdate: false, disabled: true };
  if (!force && updateCache && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.info;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { "User-Agent": "turnleaf", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = String(rel.tag_name ?? "").replace(/^v/i, "");
    const info: UpdateInfo = {
      current: VERSION,
      latest,
      url: rel.html_url,
      hasUpdate: Boolean(latest) && isNewer(latest, VERSION),
    };
    updateCache = { at: Date.now(), info };
    return info;
  } catch (e) {
    // Offline or rate-limited — never bother the user about it.
    return { current: VERSION, hasUpdate: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run a native Windows dialog via an -STA PowerShell script and return its
 * stdout (the selection, or "" if cancelled). The offscreen top-most owner
 * form makes the dialog reliably come to the front.
 */
function psDialog(scriptLines: string[], env: Record<string, string>): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.StartPosition = 'Manual'; $owner.Left = -3000; $owner.Top = -3000; $owner.Width = 1; $owner.Height = 1; $owner.TopMost = $true",
    "$owner.Show()",
    ...scriptLines,
    "$owner.Close(); $owner.Dispose()",
  ].join("\n");
  const tmp = path.join(os.tmpdir(), `fod-pick-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script);
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { env: { ...process.env, ...env } },
      (err, stdout) => {
        fs.rmSync(tmp, { force: true });
        if (err) reject(err);
        else resolve((stdout ?? "").trim());
      },
    );
  });
}

// Output folders the user has targeted this session — download is allowed from these.
const outputDirs = new Set<string>([DEFAULT_OUT, REPORTS_DIR, UPLOADS_DIR]);

interface Job {
  id: number;
  action: string;
  jars: string[];
  outDir: string;
  lines: string[];
  code: number | null;
  listeners: Set<(line: string | null) => void>;
}

const jobs = new Map<number, Job>();
let nextJobId = 1;

interface JarListing {
  name: string;
  path: string;
  size: number;
  mtime: number;
  /** Plugin name from plugin.yml (null: not a plugin, e.g. a server jar). */
  plugin: string | null;
  /** plugin.yml api-version (null on legacy pre-1.13 plugins). */
  apiVersion: string | null;
  depend: string[];
  softDepend: string[];
  /** True when this jar was produced by this converter (has our stamp). */
  converted: boolean;
  /** True when a converted jar was made by an older pipeline (re-convert it). */
  stale: boolean;
  convertedWith: string | null;
  originalName: string | null;
}

type BareListing = Omit<
  JarListing,
  "plugin" | "apiVersion" | "depend" | "softDepend" | "converted" | "stale" | "convertedWith" | "originalName"
>;

function listJars(dir: string, rel: string): BareListing[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".jar"))
    .map((f) => {
      const st = fs.statSync(path.join(abs, f));
      return { name: f, path: `${rel}/${f}`, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// plugin.yml + conversion-stamp metadata per jar, keyed by absolute path,
// invalidated by mtime.
interface CachedMeta {
  mtime: number;
  plugin: string | null;
  apiVersion: string | null;
  depend: string[];
  softDepend: string[];
  stamp: Record<string, string> | null;
}
const metaCache = new Map<string, CachedMeta>();

async function enrichJars(jars: ReturnType<typeof listJars>): Promise<JarListing[]> {
  const missing = jars.filter((j) => {
    const cached = metaCache.get(path.join(ROOT, j.path));
    return !cached || cached.mtime !== j.mtime;
  });
  if (missing.length > 0) {
    const metas = await jarMetas(missing.map((j) => path.join(ROOT, j.path)));
    for (const [i, m] of metas.entries()) {
      const meta = parsePluginMeta(m.pluginYml);
      metaCache.set(path.join(ROOT, missing[i].path), {
        mtime: missing[i].mtime,
        plugin: meta?.name ?? null,
        apiVersion: meta?.apiVersion ?? null,
        depend: meta?.depend ?? [],
        softDepend: meta?.softDepend ?? [],
        stamp: parseStamp(m.properties),
      });
    }
  }
  const currentHash = pipelineHash();
  return jars.map((j) => {
    const m = metaCache.get(path.join(ROOT, j.path))!;
    return {
      ...j,
      plugin: m.plugin,
      apiVersion: m.apiVersion,
      depend: m.depend,
      softDepend: m.softDepend,
      converted: m.stamp !== null,
      stale: m.stamp !== null && m.stamp["pipeline-hash"] !== currentHash,
      convertedWith: m.stamp?.["converter-version"] ?? (m.stamp ? "pre-0.3.0" : null),
      originalName: m.stamp?.["original-name"] ?? null,
    };
  });
}

/** Only allow jar paths inside the project's known jar directories. */
function safeJarPath(relPath: unknown): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  const abs = path.resolve(ROOT, relPath);
  const allowed = ["tests", "uploads", "out"].map((d) => path.join(ROOT, d) + path.sep);
  if (!abs.endsWith(".jar") || !allowed.some((d) => abs.startsWith(d)) || !fs.existsSync(abs)) return null;
  return abs;
}

function startJob(
  action: string,
  jarPaths: string[],
  outDir: string,
  options: { limit?: string; model?: string; t2?: boolean; strength?: string; logText?: string },
): Job {
  const args: string[] = [...selfCommand(), action];
  if (action === "verify" || action === "convert") args.push(...jarPaths);
  else args.push(jarPaths[0]);

  if (action === "convert") {
    if (options.t2 === false) args.push("--no-t2");
    args.push("--out-dir", outDir);
  }
  if (action === "migrate" && options.t2 === false) args.push("--no-t2");
  if (action === "ai") {
    if (options.limit) args.push("--limit", String(options.limit));
    if (options.strength) args.push("--strength", String(options.strength));
  }
  if (action === "repair") {
    if (options.logText && options.logText.trim()) {
      const logFile = path.join(UPLOADS_DIR, `crash-${Date.now()}.log`);
      fs.writeFileSync(logFile, options.logText);
      args.push("--log", logFile);
    } else {
      args.push("--boot");
      // Boot alongside the other converted jars sitting next to it (deps).
      const dir = path.dirname(jarPaths[0]);
      const siblings = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jar") && path.join(dir, f) !== jarPaths[0])
        .map((f) => path.join(dir, f));
      if (siblings.length > 0) args.push("--with", ...siblings);
    }
    if (options.strength) args.push("--strength", String(options.strength));
    if (options.limit) args.push("--limit", String(options.limit));
  }

  const job: Job = { id: nextJobId++, action, jars: jarPaths, outDir, lines: [], code: null, listeners: new Set() };
  jobs.set(job.id, job);

  // Jobs must see the key as saved *now*, not the one this server started with
  // (dotenv never overrides an inherited env var, so scrub it here).
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  const key = readApiKey();
  if (key) env.DEEPSEEK_API_KEY = key;

  const child = spawn(process.execPath, args, { cwd: ROOT, env });
  const emit = (line: string) => {
    job.lines.push(line);
    for (const l of job.listeners) l(line);
  };
  let buffer = "";
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      emit(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    if (buffer.trim()) emit(buffer);
    job.code = code ?? -1;
    for (const l of job.listeners) l(null);
    job.listeners.clear();
  });
  return job;
}

export async function startGui(port: number, openBrowser: boolean): Promise<void> {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(DEFAULT_OUT, { recursive: true });
  const app = express();
  // Crash logs pasted into repair/analyze bodies can be several MB.
  app.use(express.json({ limit: "25mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/status", (_req, res) => {
    const ai = loadAiSettings();
    const aiConfigured = Boolean(ai.apiKey || readApiKey() || process.env.DEEPSEEK_API_KEY);
    const serverJar = findServerJar();
    res.json({
      version: VERSION,
      serverJar,
      serverMc: mcVersionOf(serverJar),
      catalogMc: catalogMcVersion(),
      ready: fs.existsSync(ENGINE_JAR) && fs.existsSync(SHIM_JAR),
      vineflower: fs.existsSync(VINEFLOWER_JAR),
      deepseekKey: aiConfigured,
      ai: {
        configured: aiConfigured,
        provider: ai.provider,
        resolved: ai.apiKey ? (ai.provider === "auto" ? detectProvider(ai.apiKey) : ai.provider) : null,
        model: ai.model ?? "",
        baseUrl: ai.baseUrl ?? "",
        strength: ai.strength,
      },
      defaultOut: DEFAULT_OUT,
      setupDone: fs.existsSync(SETUP_MARKER),
    });
  });

  // Save AI provider settings (.ai.json). An empty apiKey with keepKey keeps
  // the stored one; an empty apiKey without keepKey clears it.
  app.post("/api/settings/ai", (req, res) => {
    const b = (req.body ?? {}) as Partial<AiSettings> & { keepKey?: boolean };
    const current = loadAiSettings();
    const next: AiSettings = {
      provider: (b.provider as AiSettings["provider"]) ?? current.provider,
      apiKey: typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : b.keepKey ? current.apiKey : "",
      baseUrl: typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim() : undefined,
      model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
      strength: (b.strength as AiSettings["strength"]) ?? current.strength,
    };
    saveAiSettings(next);
    res.json({ ok: true, configured: Boolean(next.apiKey) });
  });

  app.get("/api/update-check", async (req, res) => {
    res.json(await checkForUpdate(req.query.force === "1"));
  });

  // The launcher calls this when it finds a server from an OLDER app version
  // still holding the port (e.g. an instance that outlived an update) — the
  // stale server steps aside so the new one can sync fresh resources.
  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 150);
  });

  app.post("/api/analyze-crash", (req, res) => {
    const logText = String(req.body?.logText ?? "");
    if (!logText.trim()) {
      res.status(400).json({ error: "paste a crash log first" });
      return;
    }
    res.json({ incidents: analyzeCrashText(logText) });
  });

  // ---- live log watching ----

  app.post("/api/watch", (req, res) => {
    const file = path.resolve(String(req.body?.file ?? "").trim());
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.status(400).json({ error: "log file not found" });
      return;
    }
    startLogWatch(file);
    res.json({ ok: true, file });
  });

  app.delete("/api/watch", (_req, res) => {
    stopLogWatch();
    res.json({ ok: true });
  });

  app.get("/api/watch/status", (_req, res) => {
    res.json(logWatch ? { watching: logWatch.file, incidents: logWatch.incidents.length } : { watching: null });
  });

  app.get("/api/watch/stream", (req, res) => {
    if (!logWatch) {
      res.status(404).end();
      return;
    }
    const w = logWatch;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === "stopped") res.end();
    };
    for (const inc of w.incidents) send("incident", inc);
    w.listeners.add(send);
    req.on("close", () => w.listeners.delete(send));
  });

  // ---- "what changed?" diff viewer ----

  // Which classes were rewritten in a converted jar + where its original is.
  app.get("/api/diff-info", (req, res) => {
    const jar = safeJarPath(String(req.query.path ?? ""));
    if (!jar) {
      res.status(404).json({ error: "jar not found" });
      return;
    }
    const cached = metaCache.get(jar);
    const originalName = cached?.stamp?.["original-name"] ?? path.basename(jar).replace(/-folia(-t3|-repaired)?\.jar$/, ".jar");
    const original = [path.join(ROOT, "uploads", originalName), path.join(ROOT, "tests", originalName)].find((p) => fs.existsSync(p));
    const reportFile = path.join(REPORTS_DIR, `${originalName.replace(/\.jar$/, "")}.convert.json`);
    let classes: string[] = [];
    if (fs.existsSync(reportFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as { result?: { modifiedClasses?: string[] } };
        classes = report.result?.modifiedClasses ?? [];
      } catch {
        // fall through with empty list
      }
    }
    res.json({
      original: original ? path.relative(ROOT, original).replaceAll("\\", "/") : null,
      classes,
      hint: classes.length === 0 ? "No modified-class list found — re-convert this jar with the current version first." : null,
    });
  });

  // Decompile one class from the original and converted jars and diff them.
  app.post("/api/diff", async (req, res) => {
    try {
      const conv = safeJarPath(String(req.body?.converted ?? ""));
      const orig = safeJarPath(String(req.body?.original ?? ""));
      const cls = String(req.body?.cls ?? "");
      if (!conv || !orig || !/^[\w/$-]+$/.test(cls)) {
        res.status(400).json({ error: "bad jar paths or class name" });
        return;
      }
      const work = path.join(os.tmpdir(), `fod-diff-${Date.now()}`);
      const sides: Record<string, string> = {};
      for (const [label, jar] of [["before", orig], ["after", conv]] as const) {
        const classesDir = path.join(work, label, "classes");
        const srcDir = path.join(work, label, "src");
        await extractClasses(jar, classesDir, [cls]);
        await decompile(classesDir, srcDir, jar, []);
        const file = path.join(srcDir, `${cls}.java`);
        sides[label] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      }
      fs.rmSync(work, { recursive: true, force: true });
      if (!sides.before || !sides.after) {
        res.json({ error: "decompilation produced no source for one side" });
        return;
      }
      res.json({ diff: unifiedDiff(sides.before, sides.after) });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Prefill a GitHub issue from a crash incident and open it in the browser.
  // The trace is scrubbed (UUIDs, IPs, usernames) before it leaves the machine.
  app.post("/api/report-issue", (req, res) => {
    if (!UPDATE_REPO) {
      res.json({ error: "No GitHub repository configured for this build." });
      return;
    }
    const inc = (req.body ?? {}) as { header?: string; tag?: string; jars?: string[]; excerpt?: string };
    const title = `[crash] ${inc.tag ?? "unknown"}: ${scrub(String(inc.header ?? "")).replace(/^\[.*?\]:?\s*/, "").slice(0, 90)}`;
    const body = [
      `**Plugin jar**: ${(inc.jars ?? []).join(", ") || "unknown"}`,
      `**Diagnosis**: ${inc.tag ?? "unknown"}`,
      `**Turnleaf**: ${VERSION} · **Server**: ${mcVersionOf(findServerJar()) ?? "unknown"}`,
      "",
      "**Trace** (scrubbed):",
      "```",
      scrub(String(inc.excerpt ?? "")).slice(0, 2500),
      "```",
    ].join("\n");
    // encodeURIComponent leaves ' ( ) ! * ~ alone — escape ' too so the URL is
    // safe inside a PowerShell double-quoted string (cmd `start` mangles & and %).
    const q = (s: string) => encodeURIComponent(s).replaceAll("'", "%27");
    const url = `https://github.com/${UPDATE_REPO}/issues/new?title=${q(title)}&body=${q(body)}`;
    if (process.platform === "win32") {
      spawn("powershell", ["-NoProfile", "-Command", `Start-Process "${url}"`], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
    res.json({ ok: true });
  });

  // Download the latest stable Folia build straight from PaperMC (Fill API),
  // verify its sha256, and install it as the app's server jar.
  app.post("/api/settings/download-folia", async (_req, res) => {
    try {
      const proj = (await (await fetch("https://fill.papermc.io/v3/projects/folia", { signal: AbortSignal.timeout(15_000) })).json()) as {
        versions: Record<string, string[]>;
      };
      const latest = Object.values(proj.versions)[0]?.[0];
      if (!latest) throw new Error("no Folia versions listed");
      const build = (await (
        await fetch(`https://fill.papermc.io/v3/projects/folia/versions/${latest}/builds/latest`, { signal: AbortSignal.timeout(15_000) })
      ).json()) as { downloads?: Record<string, { name: string; url: string; checksums?: { sha256?: string } }> };
      const dl = build.downloads?.["server:default"];
      if (!dl) throw new Error(`no server download for Folia ${latest}`);

      const jar = Buffer.from(await (await fetch(dl.url, { signal: AbortSignal.timeout(300_000) })).arrayBuffer());
      const sha = crypto.createHash("sha256").update(jar).digest("hex");
      if (dl.checksums?.sha256 && sha !== dl.checksums.sha256) {
        throw new Error("downloaded jar failed its sha256 check — try again");
      }
      fs.mkdirSync(FOLIA_DIR, { recursive: true });
      for (const f of fs.readdirSync(FOLIA_DIR)) {
        if (f.endsWith(".jar")) fs.rmSync(path.join(FOLIA_DIR, f), { force: true });
      }
      fs.writeFileSync(path.join(FOLIA_DIR, dl.name), jar);
      res.json({ ok: true, serverJar: dl.name, version: latest });
    } catch (e) {
      res.json({ error: `Download failed: ${e instanceof Error ? e.message : e}` });
    }
  });

  // ---- storage housekeeping ----

  const CLEANABLE = () => [
    REPORTS_DIR,
    path.join(TOOLS_DIR, "t3-work"),
    path.join(TOOLS_DIR, "repair-work"),
    path.join(FOLIA_DIR, "work", "logs"),
  ];

  const dirSize = (dir: string): number => {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
    return total;
  };

  app.get("/api/storage", (_req, res) => {
    // Crash logs written for repair jobs live in uploads/ next to user jars.
    const crashLogs = fs.existsSync(UPLOADS_DIR)
      ? fs.readdirSync(UPLOADS_DIR).filter((f) => /^crash-\d+\.log$/.test(f)).map((f) => path.join(UPLOADS_DIR, f))
      : [];
    const cleanable = CLEANABLE().reduce((a, d) => a + dirSize(d), 0) + crashLogs.reduce((a, f) => a + fs.statSync(f).size, 0);
    res.json({ cleanableBytes: cleanable });
  });

  app.post("/api/cleanup", (_req, res) => {
    let freed = 0;
    for (const dir of CLEANABLE()) {
      freed += dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    if (fs.existsSync(UPLOADS_DIR)) {
      for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (/^crash-\d+\.log$/.test(f)) {
          const p = path.join(UPLOADS_DIR, f);
          freed += fs.statSync(p).size;
          fs.rmSync(p, { force: true });
        }
      }
    }
    res.json({ ok: true, freedBytes: freed });
  });

  // Native file picker for a server log (Windows; elsewhere type the path).
  app.post("/api/pick-log", async (_req, res) => {
    if (process.platform !== "win32") {
      res.json({ error: "The file picker is Windows-only here — paste the path to logs/latest.log instead." });
      return;
    }
    try {
      const picked = await psDialog(
        [
          "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
          "$dlg.Title = 'Choose your server log (logs\\latest.log)'",
          "$dlg.Filter = 'Log files (*.log)|*.log|All files (*.*)|*.*'",
          "$res = $dlg.ShowDialog($owner)",
          "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }",
        ],
        {},
      );
      res.json(picked ? { path: picked } : { cancelled: true });
    } catch (e) {
      res.json({ error: `Could not open the file picker: ${e instanceof Error ? e.message : e}` });
    }
  });

  // Open the release page in the user's real browser (the app window itself
  // must stay on the local UI). Locked to github.com so this can't be abused.
  app.post("/api/open-release", async (_req, res) => {
    const info = await checkForUpdate(false);
    if (!info.url || !info.url.startsWith("https://github.com/")) {
      res.status(400).json({ error: "no release page known" });
      return;
    }
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", info.url], { stdio: "ignore", detached: true }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [info.url], { stdio: "ignore", detached: true }).unref();
    res.json({ ok: true });
  });

  // ---- settings (first-run setup + changeable later) ----

  app.post("/api/settings/setup-done", (_req, res) => {
    fs.writeFileSync(SETUP_MARKER, new Date().toISOString());
    res.json({ ok: true });
  });

  app.post("/api/settings/api-key", (req, res) => {
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    writeApiKey(key);
    res.json({ ok: true, deepseekKey: Boolean(key) });
  });

  // Native file picker → copy the chosen Folia server jar into folia/.
  app.post("/api/settings/server-jar", async (_req, res) => {
    if (process.platform !== "win32") {
      res.json({ error: `The file picker is Windows-only here — copy your server jar into ${FOLIA_DIR} instead.` });
      return;
    }
    try {
      const picked = await psDialog(
        [
          "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
          "$dlg.Title = 'Choose your Folia server jar'",
          "$dlg.Filter = 'Server jar (*.jar)|*.jar'",
          "if ($env:FOD_START) { $dlg.InitialDirectory = $env:FOD_START }",
          "$res = $dlg.ShowDialog($owner)",
          "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }",
        ],
        { FOD_START: path.join(os.homedir(), "Downloads") },
      );
      if (!picked) {
        res.json({ cancelled: true });
        return;
      }
      fs.mkdirSync(FOLIA_DIR, { recursive: true });
      // One server jar at a time — replace whatever is there so the boot
      // harness never has to guess which jar to launch.
      for (const f of fs.readdirSync(FOLIA_DIR)) {
        if (f.endsWith(".jar")) fs.rmSync(path.join(FOLIA_DIR, f), { force: true });
      }
      const name = path.basename(picked);
      fs.copyFileSync(picked, path.join(FOLIA_DIR, name));
      res.json({ ok: true, serverJar: name });
    } catch (e) {
      res.json({ error: `Could not set the server jar: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.get("/api/jars", async (_req, res) => {
    try {
      const [tests, uploads, out] = await Promise.all([
        enrichJars(listJars("tests", "tests")),
        enrichJars(listJars("uploads", "uploads")),
        enrichJars(listJars("out", "out")),
      ]);
      res.json({ tests, uploads, out });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Native OS folder picker — the server runs locally, so it can pop the real
  // Explorer dialog and return the chosen absolute path.
  app.post("/api/pick-folder", async (req, res) => {
    if (process.platform !== "win32") {
      res.json({ error: "The folder picker is Windows-only here — type or paste the path instead." });
      return;
    }
    const start = String((req.body?.start ?? DEFAULT_OUT) || DEFAULT_OUT);
    try {
      const picked = await psDialog(
        [
          "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$dlg.Description = 'Choose the output folder for the converted plugin'",
          "$dlg.ShowNewFolderButton = $true",
          "if ($env:FOD_START) { $dlg.SelectedPath = $env:FOD_START }",
          "$res = $dlg.ShowDialog($owner)",
          "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }",
        ],
        { FOD_START: start },
      );
      res.json(picked ? { path: picked } : { cancelled: true });
    } catch (e) {
      res.json({ error: `Could not open the folder picker: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.post("/api/upload", express.raw({ type: () => true, limit: "300mb" }), (req, res) => {
    const name = path.basename(String(req.query.name ?? ""));
    if (!name.endsWith(".jar")) {
      res.status(400).json({ error: "file name must end in .jar" });
      return;
    }
    if (!(req.body instanceof Buffer) || req.body.length === 0) {
      res.status(400).json({ error: "no jar data received in the upload body" });
      return;
    }
    fs.writeFileSync(path.join(UPLOADS_DIR, name), req.body);
    res.json({ ok: true, path: `uploads/${name}`, name });
  });

  app.post("/api/jobs", (req, res) => {
    const { action, jars, dir, outDir, options } = req.body as {
      action: string;
      jars?: string[];
      dir?: string;
      outDir?: string;
      options?: Record<string, unknown>;
    };
    // Migrate takes a server directory, not jars from the library.
    let resolved: (string | null)[];
    if (action === "migrate") {
      const serverDir = typeof dir === "string" ? path.resolve(dir.trim()) : "";
      if (!serverDir || !fs.existsSync(serverDir) || !fs.statSync(serverDir).isDirectory()) {
        res.status(400).json({ error: "server folder not found" });
        return;
      }
      resolved = [serverDir];
    } else {
      if (!ACTIONS.has(action) || !Array.isArray(jars) || jars.length === 0) {
        res.status(400).json({ error: "invalid action or jars" });
        return;
      }
      resolved = jars.map(safeJarPath);
      if (resolved.some((p) => p === null)) {
        res.status(400).json({ error: "jar not found or outside allowed directories" });
        return;
      }
    }
    let target = DEFAULT_OUT;
    if (outDir && outDir.trim()) {
      target = path.resolve(outDir.trim());
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (e) {
        res.status(400).json({ error: `cannot create output folder: ${e instanceof Error ? e.message : e}` });
        return;
      }
      outputDirs.add(target);
    }
    const job = startJob(
      action,
      resolved as string[],
      target,
      (options ?? {}) as { limit?: string; model?: string; t2?: boolean; strength?: string; logText?: string },
    );
    res.json({ id: job.id });
  });

  app.get("/api/jobs/:id/stream", (req, res) => {
    const job = jobs.get(Number(req.params.id));
    if (!job) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const send = (line: string | null) => {
      if (line === null) {
        res.write(`event: done\ndata: ${JSON.stringify({ code: job.code, outDir: job.outDir })}\n\n`);
        res.end();
      } else {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    };
    for (const line of job.lines) send(line);
    if (job.code !== null) {
      send(null);
      return;
    }
    job.listeners.add(send);
    req.on("close", () => job.listeners.delete(send));
  });

  app.get("/api/reports/:name", (req, res) => {
    const file = path.join(REPORTS_DIR, path.basename(req.params.name));
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "no report" });
      return;
    }
    res.sendFile(file);
  });

  app.get("/api/download", (req, res) => {
    const abs = path.resolve(String(req.query.path ?? ""));
    const ok = [...outputDirs].some((d) => abs.startsWith(d + path.sep) || abs === d);
    if (!ok || !fs.existsSync(abs)) {
      res.status(404).end();
      return;
    }
    res.download(abs);
  });

  await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  console.log(`Turnleaf GUI running at ${url}`);
  if (openBrowser) {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  }
}
