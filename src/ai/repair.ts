import fs from "node:fs";
import path from "node:path";
import { extractClasses, indexJar, updateJar } from "../engine/client.js";
import { parsePluginMeta } from "../scan/scanner.js";
import { bootWithPlugins } from "../verify/harness.js";
import { TOOLS_DIR } from "../env.js";
import { scrub } from "../util/scrub.js";
import { createProvider, loadAiSettings, type Strength } from "./provider.js";
import { STRENGTH_PROFILE, compileGate, decompile } from "./tier3.js";
import { applyPatch, parsePatch } from "./patches.js";

/**
 * Self-repair loop: take a crash log (pasted, from a file, or produced by
 * booting the jar on the local Folia server), locate the plugin classes in
 * each stack trace, decompile just those, ask the AI for a fix, and land it
 * only after the compile gate. With --boot it re-boots after patching and
 * repeats until clean or out of passes.
 */

const SYSTEM_PROMPT = `You are a Java expert fixing a Minecraft plugin that crashes on Folia (a multithreaded Paper fork: event handlers and tasks run on many region threads concurrently; entities/blocks may only be touched from the thread owning their region).

You are given a crash stack trace and the decompiled source of the involved plugin classes.

HARD RULES:
- Fix the crash. Preserve the plugin's features and observable behavior in the non-crashing paths EXACTLY.
- Do not rename, add, or remove public/protected members. Keep every method signature identical.
- Prefer the minimal correct fix: null/thread-ownership guards, deferring work to the right scheduler, thread-safe data access, tolerating a missing optional dependency.
- The code must compile against the provided sources plus the original jar. Do not invent classes or imports that don't exist.

OUTPUT FORMAT — respond with ONLY a JSON object, nothing else:
{"edits": [{"file": "<internal class name, e.g. com/example/Foo>", "search": "<exact text from the provided source>", "replace": "<replacement text>"}], "notes": "<one-line summary of the fix>"}

Each "search" must be copied character-for-character from the provided source and must be unique within its file.`;

export interface Incident {
  /** The exception header line(s), including Caused by chain heads. */
  header: string;
  /** Full trace excerpt shown to the model. */
  excerpt: string;
  /** Outer plugin classes to decompile+patch (root-cause frames first). */
  classes: string[];
  /** Jar names seen in the matched frames' classloader prefixes (attribution). */
  jars: string[];
}

export interface RepairOptions {
  logFile?: string;
  logText?: string;
  boot?: boolean;
  /** Extra plugin jars installed alongside when booting (converted dependencies). */
  withJars?: string[];
  strength?: Strength;
  model?: string;
  limit?: number;
  libs?: string[];
}

export interface IncidentResult {
  header: string;
  status: "patched" | "skipped" | "failed";
  detail: string;
  classes: string[];
  notes?: string;
}

export interface RepairOutcome {
  repairedJar: string | null;
  passes: { incidents: number; results: IncidentResult[] }[];
  /** Only set when --boot: whether the final boot came back clean. */
  finalBootOk?: boolean;
}

/** Frames from injected shim classes are ours — never patch targets. */
const isShimClass = (cls: string) => cls.includes("foliaondemand") || cls.includes("foliashim");

/** Lines that describe environment problems the AI must not "fix" in code. */
const NOT_A_CODE_BUG = /UnknownDependencyException|missing dependency|Please download and install/i;

/**
 * Extract the class name (and the classloader jar, when present) from a stack
 * frame, tolerating module ("java.base/") and jar ("some-plugin.jar//")
 * prefixes.
 */
export function frameInfo(line: string): { cls: string; jar: string | null } | null {
  const m = line.match(/^\s*(?:\[.*?\]:?\s*)?at\s+([^\s(]+)\(/);
  if (!m) return null;
  const segments = m[1].split("/");
  const qualified = segments.pop() ?? "";
  const jar = segments.find((s) => s.endsWith(".jar")) ?? null;
  const lastDot = qualified.lastIndexOf(".");
  return lastDot > 0 ? { cls: qualified.slice(0, lastDot), jar } : null;
}

const isFrame = (l: string) => /^\s*(?:\[.*?\]:?\s*)?at\s+\S+\(/.test(l);
const isCausedBy = (l: string) => /^\s*(?:\[.*?\]:?\s*)?Caused by:/.test(l);
const isEllipsis = (l: string) => /^\s*(?:\[.*?\]:?\s*)?\.\.\.\s*\d+\s+(?:more|common frames omitted)/.test(l);
const isBareException = (l: string) => /^\s*(?:\[.*?\]:?\s*)?[\w.$]+(?:Exception|Error)\b(?::.*)?\s*$/.test(l);

/**
 * Parse plugin-scoped crash incidents out of a server log / pasted stack trace.
 * A block = an exception header, its frames, and any Caused-by chain — kept
 * only if at least one frame satisfies `isPluginClass` (internal name + jar).
 */
export function parseIncidents(
  logText: string,
  isPluginClass: (cls: string, jar: string | null) => boolean,
): Incident[] {
  const lines = logText.split(/\r?\n/);
  const incidents: Incident[] = [];
  const seen = new Set<string>();

  let block: string[] = [];
  let blockClasses: string[] = [];
  let blockJars: string[] = [];
  let header = "";
  let sawFrame = false;

  const flush = () => {
    if (header && blockClasses.length > 0 && !NOT_A_CODE_BUG.test(block.join("\n"))) {
      const key = `${header.replace(/^\[.*?\]:?\s*/, "")}::${blockClasses[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        incidents.push({
          header,
          excerpt: block.slice(0, 45).join("\n"),
          // Prefer the deepest (root-cause) frames: later entries come from
          // Caused-by blocks, so take from the END of the list.
          classes: [...new Set(blockClasses.map((c) => c.split("$")[0]))].slice(-3).reverse(),
          jars: [...new Set(blockJars)],
        });
      }
    }
    block = [];
    blockClasses = [];
    blockJars = [];
    header = "";
    sawFrame = false;
  };

  for (const line of lines) {
    if (header) {
      const cont =
        isFrame(line) ||
        isCausedBy(line) ||
        isEllipsis(line) ||
        // A bare exception line directly under an ERROR header (before frames).
        (!sawFrame && isBareException(line));
      if (cont) {
        block.push(line);
        if (isFrame(line)) {
          sawFrame = true;
          const info = frameInfo(line);
          const cls = info?.cls.replaceAll(".", "/");
          if (info && cls && isPluginClass(cls.split("$")[0], info.jar) && !isShimClass(cls)) {
            blockClasses.push(cls);
            if (info.jar) blockJars.push(info.jar);
          }
        }
        continue;
      }
      flush();
    }
    if (/ERROR/.test(line) || isBareException(line)) {
      header = line.trim();
      block = [line];
      sawFrame = false;
    }
  }
  flush();
  return incidents;
}

function buildUserPrompt(incident: Incident, sources: Map<string, string>, feedback: string | null): string {
  const parts: string[] = ["=== CRASH ===", scrub(incident.excerpt), ""];
  for (const [cls, src] of sources) {
    parts.push(`=== FILE: ${cls} ===`, src, "");
  }
  if (feedback) {
    parts.push("=== PREVIOUS ATTEMPT FAILED ===", feedback, "Re-emit the FULL corrected JSON patch.");
  }
  return parts.join("\n");
}

async function collectBootLog(jarPath: string, withJars: string[]): Promise<{ logText: string; ok: boolean }> {
  const jars = [jarPath, ...withJars];
  const names: string[] = [];
  const scopes: string[] = [];
  for (const p of jars) {
    const meta = parsePluginMeta((await indexJar(p)).pluginYml);
    names.push(meta?.name ?? path.basename(p, ".jar"));
    if (meta?.main) scopes.push(meta.main.slice(0, meta.main.lastIndexOf(".")));
  }
  console.log(`Booting Folia with ${names.join(" + ")} to look for crashes…`);
  const boot = await bootWithPlugins(jars, names, { expectMarkers: [], pluginScopes: scopes, timeoutSeconds: 480 });
  return { logText: fs.readFileSync(boot.logFile, "utf8"), ok: boot.ok };
}

export async function runRepair(jarPath: string, options: RepairOptions): Promise<RepairOutcome> {
  const settings = loadAiSettings();
  const strength = options.strength ?? settings.strength;
  const profile = STRENGTH_PROFILE[strength];
  const limit = options.limit ?? profile.limit;
  const maxPasses = options.boot ? { quick: 1, standard: 2, deep: 3 }[strength] : 1;
  const provider = createProvider(options.model, { ...settings, strength });

  const inputDir = path.dirname(path.resolve(jarPath));
  const siblingJars = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".jar") && path.resolve(inputDir, f) !== path.resolve(jarPath))
    .map((f) => path.join(inputDir, f));
  const libs = [...(options.libs ?? []).map((l) => path.resolve(l)), ...siblingJars];

  const workRoot = path.join(TOOLS_DIR, "repair-work");
  fs.rmSync(workRoot, { recursive: true, force: true });

  let workingJar = path.resolve(jarPath);
  let patchedTotal = 0;
  const passes: RepairOutcome["passes"] = [];
  let finalBootOk: boolean | undefined;

  const repairedJar = jarPath.replace(/\.jar$/, "-repaired.jar");

  for (let pass = 1; pass <= maxPasses; pass++) {
    // 1. Get the crash log for this pass.
    let logText: string;
    if (pass === 1 && options.logText) logText = options.logText;
    else if (pass === 1 && options.logFile) logText = fs.readFileSync(options.logFile, "utf8");
    else {
      const boot = await collectBootLog(workingJar, options.withJars ?? []);
      logText = boot.logText;
      finalBootOk = boot.ok;
      if (boot.ok) {
        console.log(`Boot is clean — nothing to repair${pass > 1 ? " after patching" : ""}.`);
        break;
      }
    }

    // 2. Find incidents that involve this plugin's classes.
    const index = await indexJar(workingJar);
    const pluginClasses = new Set(index.classes.map((c) => c.name.split("$")[0]).filter((c) => !isShimClass(c)));
    const incidents = parseIncidents(logText, (cls) => pluginClasses.has(cls)).slice(0, limit);
    console.log(`Pass ${pass}: ${incidents.length} crash incident(s) involving plugin code (provider: ${provider.name})`);
    if (incidents.length === 0) {
      if (pass === 1) console.log("No stack traces matching this plugin's classes were found in the log.");
      break;
    }

    // 3. Patch each incident behind the compile gate.
    const results: IncidentResult[] = [];
    for (const [i, incident] of incidents.entries()) {
      const workDir = path.join(workRoot, `p${pass}-i${i}`);
      const label = incident.header.slice(0, 120);
      console.log(`  [${i + 1}/${incidents.length}] ${label}`);

      const classesDir = path.join(workDir, "classes");
      const srcDir = path.join(workDir, "decompiled");
      await extractClasses(workingJar, classesDir, incident.classes);
      await decompile(classesDir, srcDir, workingJar, libs);

      // Keep only classes whose decompiled source recompiles on its own — a
      // huge class with decompiler artifacts must not block fixing the
      // root-cause class (the other classes still resolve from the jar).
      const sources = new Map<string, string>();
      let lastError = "";
      for (const cls of incident.classes) {
        const file = path.join(srcDir, `${cls}.java`);
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, "utf8");
        const single = await compileGate(new Map([[cls, src]]), workDir, workingJar, libs);
        if (single.ok) sources.set(cls, src);
        else lastError = single.errors;
      }
      if (sources.size === 0) {
        results.push({
          header: label,
          status: "skipped",
          detail: `no involved class recompiles from decompiled source: ${lastError.slice(0, 300)}`,
          classes: incident.classes,
        });
        continue;
      }
      if (sources.size > 1) {
        // Joint gate — if the survivors don't compile together, fall back to
        // just the root-cause class (first in the list).
        const joint = await compileGate(sources, workDir, workingJar, libs);
        if (!joint.ok) {
          const rootCls = incident.classes.find((c) => sources.has(c))!;
          const rootSrc = sources.get(rootCls)!;
          sources.clear();
          sources.set(rootCls, rootSrc);
        }
      }

      let feedback: string | null = null;
      let landed = false;
      for (let round = 1; round <= profile.rounds; round++) {
        console.log(`    round ${round}: asking ${provider.name}…`);
        const response = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(incident, sources, feedback));
        const { patch, error } = parsePatch(response);
        if (!patch) {
          feedback = `Your response could not be parsed: ${error}`;
          continue;
        }
        const { applied, errors } = applyPatch(sources, patch);
        if (!applied) {
          feedback = `Edits failed to apply:\n${errors.join("\n")}`;
          continue;
        }
        const gate = await compileGate(applied, workDir, workingJar, libs);
        if (!gate.ok) {
          feedback = `Patched code failed to compile:\n${gate.errors}`;
          continue;
        }
        const nextJar = path.join(workDir, "patched.jar");
        await updateJar(workingJar, gate.outDir, nextJar);
        workingJar = nextJar;
        patchedTotal++;
        landed = true;
        results.push({ header: label, status: "patched", detail: `${patch.edits.length} edit(s) in round ${round}`, classes: incident.classes, notes: patch.notes });
        console.log(`    ✔ ${patch.notes ?? "patched"}`);
        break;
      }
      if (!landed) {
        results.push({ header: label, status: "failed", detail: feedback?.slice(0, 300) ?? "exhausted rounds", classes: incident.classes });
        console.log(`    ✖ gave up after ${profile.rounds} rounds`);
      }
    }
    passes.push({ incidents: incidents.length, results });

    if (!results.some((r) => r.status === "patched")) break; // nothing landed — repeating won't help
    fs.copyFileSync(workingJar, repairedJar);

    if (!options.boot) break;
  }

  // Final verification boot when in boot mode and we patched something.
  if (options.boot && patchedTotal > 0 && finalBootOk !== true) {
    const boot = await collectBootLog(repairedJar, options.withJars ?? []);
    finalBootOk = boot.ok;
  }

  return { repairedJar: patchedTotal > 0 ? repairedJar : null, passes, finalBootOk };
}
