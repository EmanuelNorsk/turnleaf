import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { convert } from "../convert/convert.js";
import { extractClasses, indexJar, updateJar } from "../engine/client.js";
import { analyzeSharedState } from "../analyze/sharedState.js";
import { loadCatalog, scan } from "../scan/scanner.js";
import type { ConvertOutcome, Tier3Target } from "../types.js";
import { OUT_DIR, TOOLS_DIR, VINEFLOWER_JAR as VINEFLOWER, readPaperClasspath } from "../env.js";
import { createProvider, loadAiSettings, type Strength } from "./provider.js";
import { applyPatch, parsePatch } from "./patches.js";

const execFileAsync = promisify(execFile);

/** How hard each AI strength level tries. */
export const STRENGTH_PROFILE: Record<Strength, { limit: number; rounds: number; maxClasses: number }> = {
  quick: { limit: 3, rounds: 2, maxClasses: 6 },
  standard: { limit: 8, rounds: 3, maxClasses: 6 },
  deep: { limit: 20, rounds: 5, maxClasses: 10 },
};

const DEEP_GUIDANCE = `
DEEP MODE — you may go beyond minimal patches when it produces better code:
- If the shared state is better served by restructuring (e.g. splitting a monolithic map into per-region state, or replacing check-then-act with a designed atomic API on the same field), do it — but keep every public/protected signature identical and behavior observable-equivalent.
- Carve the fix into the code properly instead of wrapping: prefer changing the algorithm to be thread-safe over sprinkling synchronized blocks.
- You may make several coordinated edits across the provided files.`;

const SYSTEM_PROMPT = `You are a Java concurrency expert making Minecraft plugins safe for Folia (a multithreaded Paper fork where event handlers and tasks run on many region threads concurrently).

HARD RULES:
- Preserve the plugin's features, logic, and observable behavior EXACTLY. You only make existing behavior thread-safe.
- Do not rename, add, or remove public/protected members. Keep every method signature identical.
- Prefer the minimal change: concurrent collections, atomic compound operations (computeIfAbsent, merge, putIfAbsent), or a synchronized block around an existing compound check-then-act.
- If a field's declared type must change (e.g. LinkedHashMap -> Map wrapped in Collections.synchronizedMap), update EVERY provided file that touches it consistently.
- The code you produce must compile against the provided sources plus the original jar. Do not invent helper classes or imports that don't exist. Add needed java.util/java.util.concurrent imports in your edits.

OUTPUT FORMAT — respond with ONLY a JSON object, nothing else:
{"edits": [{"file": "<internal class name, e.g. com/example/Foo>", "search": "<exact text from the provided source>", "replace": "<replacement text>"}], "notes": "<one-line summary>"}

Each "search" must be copied character-for-character from the provided source (including whitespace/indentation) and must be unique within its file. Use multiple small edits rather than one giant one.`;

export interface Tier3Options {
  limit?: number;
  model?: string;
  strength?: Strength;
  /** Extra jars for the compile gate (dependency plugins). Sibling jars of the input are added automatically. */
  libs?: string[];
}

export interface TargetResult {
  field: string;
  status: "patched" | "skipped" | "failed";
  detail: string;
  rounds: number;
  classes: string[];
  notes?: string;
}

export interface Tier3Outcome {
  outcome: ConvertOutcome;
  finalJar: string | null;
  results: TargetResult[];
}

function paperClasspath(): string {
  return readPaperClasspath().join(path.delimiter);
}

function paperApiJar(): string {
  const entry = readPaperClasspath().find((p) => path.basename(p).startsWith("paper-api"));
  if (!entry) throw new Error("paper-api jar not found in tools/paper-classpath.txt");
  return entry;
}

export async function decompile(classesDir: string, srcDir: string, jarOnClasspath: string, libs: string[]): Promise<void> {
  await execFileAsync(
    "java",
    ["-jar", VINEFLOWER, `-e=${jarOnClasspath}`, `-e=${paperApiJar()}`, ...libs.map((l) => `-e=${l}`), classesDir, srcDir],
    { maxBuffer: 256 * 1024 * 1024 },
  );
}

export interface GateResult {
  ok: boolean;
  errors: string;
  outDir: string;
}

/** Mixed source/binary compile: patched sources against the jar + libs + paper-api. */
export async function compileGate(
  sources: Map<string, string>,
  workDir: string,
  jarOnClasspath: string,
  libs: string[],
): Promise<GateResult> {
  const srcDir = path.join(workDir, "src");
  const outDir = path.join(workDir, "out");
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files: string[] = [];
  for (const [cls, src] of sources) {
    const file = path.join(srcDir, `${cls}.java`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);
    files.push(file);
  }

  const argFile = path.join(workDir, "javac-args.txt");
  const cp = [jarOnClasspath, ...libs, paperClasspath()].join(path.delimiter);
  const quote = (s: string) => `"${s.replaceAll("\\", "\\\\")}"`;
  fs.writeFileSync(
    argFile,
    ["-encoding", "UTF-8", "-nowarn", "-proc:none", "--release", "21", "-cp", quote(cp), "-d", quote(outDir), ...files.map(quote)].join("\n"),
  );

  try {
    await execFileAsync("javac", [`@${argFile}`], { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, errors: "", outDir };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, errors: (err.stderr ?? err.message).slice(0, 6000), outDir };
  }
}

function buildUserPrompt(target: Tier3Target, contexts: string[], sources: Map<string, string>, feedback: string | null): string {
  const parts: string[] = [];
  parts.push(
    `TARGET FIELD: ${target.owner.replaceAll("/", ".")}.${target.field}`,
    `Declared type: ${target.desc.slice(1, -1).replaceAll("/", ".")}`,
    `Problem: this field is mutated from concurrent Folia contexts (${contexts.join(", ")}). Make all access to it thread-safe while preserving behavior (including iteration order semantics if the type is ordered).`,
    "",
  );
  for (const [cls, src] of sources) {
    parts.push(`=== FILE: ${cls} ===`, src, "");
  }
  if (feedback) {
    parts.push("=== PREVIOUS ATTEMPT FAILED ===", feedback, "Re-emit the FULL corrected JSON patch.");
  }
  return parts.join("\n");
}

export async function runTier3(jarPath: string, options: Tier3Options = {}): Promise<Tier3Outcome> {
  const settings = loadAiSettings();
  const strength = options.strength ?? settings.strength;
  const profile = STRENGTH_PROFILE[strength];
  const limit = options.limit ?? profile.limit;
  const maxRounds = profile.rounds;
  const systemPrompt = strength === "deep" ? SYSTEM_PROMPT + DEEP_GUIDANCE : SYSTEM_PROMPT;
  const provider = createProvider(options.model, { ...settings, strength });
  if (!fs.existsSync(VINEFLOWER)) throw new Error(`Vineflower not found at ${VINEFLOWER}`);

  // Dependency plugins for the compile gate: explicit --libs plus every
  // sibling jar of the input (a plugins folder carries its dependencies).
  const inputDir = path.dirname(path.resolve(jarPath));
  const siblingJars = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".jar") && path.resolve(inputDir, f) !== path.resolve(jarPath))
    .map((f) => path.join(inputDir, f));
  const libs = [...(options.libs ?? []).map((l) => path.resolve(l)), ...siblingJars];

  console.log(`Tier 1+2 conversion first…`);
  const outcome = await convert(jarPath, {});
  const targets = outcome.tier3Targets.slice(0, limit);
  const results: TargetResult[] = [];

  if (targets.length === 0) {
    console.log("No Tier 3 targets — nothing for the AI to do.");
    return { outcome, finalJar: null, results };
  }
  console.log(`${outcome.tier3Targets.length} Tier 3 target(s), processing ${targets.length} (provider: ${provider.name})\n`);

  const analysis = analyzeSharedState(await indexJar(jarPath));
  const workRoot = path.join(TOOLS_DIR, "t3-work");
  fs.rmSync(workRoot, { recursive: true, force: true });

  let workingJar = outcome.outputJar;
  let patchedCount = 0;

  for (const [i, target] of targets.entries()) {
    const fieldLabel = `${target.owner.replaceAll("/", ".")}.${target.field}`;
    const workDir = path.join(workRoot, `t${i}`);
    console.log(`[${i + 1}/${targets.length}] ${fieldLabel}`);

    // Every class that touches the field must be patched consistently.
    const outIndex = await indexJar(workingJar);
    const accessorOuters = new Set<string>([target.owner.split("$")[0]]);
    for (const cls of outIndex.classes) {
      for (const m of cls.methods) {
        if (m.fieldAccesses.some((fa) => fa.owner === target.owner && fa.name === target.field)) {
          accessorOuters.add(cls.name.split("$")[0]);
        }
      }
    }
    const classes = [...accessorOuters];
    if (classes.length > profile.maxClasses) {
      results.push({ field: fieldLabel, status: "skipped", detail: `${classes.length} classes touch the field (max ${profile.maxClasses} at strength "${strength}")`, rounds: 0, classes });
      console.log(`  skipped: too many accessor classes (${classes.length})\n`);
      continue;
    }

    // Decompile.
    const classesDir = path.join(workDir, "classes");
    const srcDir = path.join(workDir, "decompiled");
    await extractClasses(workingJar, classesDir, classes);
    await decompile(classesDir, srcDir, workingJar, libs);

    const sources = new Map<string, string>();
    let missing: string | null = null;
    for (const cls of classes) {
      const file = path.join(srcDir, `${cls}.java`);
      if (!fs.existsSync(file)) {
        missing = cls;
        break;
      }
      sources.set(cls, fs.readFileSync(file, "utf8"));
    }
    if (missing) {
      results.push({ field: fieldLabel, status: "skipped", detail: `decompilation produced no source for ${missing}`, rounds: 0, classes });
      console.log(`  skipped: no decompiled source for ${missing}\n`);
      continue;
    }

    // Pre-flight: the UNPATCHED decompiled source must compile, otherwise
    // compile-gate failures would be Vineflower's fault, not the model's.
    const preflight = await compileGate(sources, workDir, workingJar, libs);
    if (!preflight.ok) {
      results.push({ field: fieldLabel, status: "skipped", detail: `decompiled source does not recompile (pre-flight): ${preflight.errors.slice(0, 300)}`, rounds: 0, classes });
      console.log(`  skipped: pre-flight compile failed (decompiler output not rebuildable)\n`);
      continue;
    }

    // Ask → apply → gate loop.
    const contexts = analysis.findings.find((f) => f.owner === target.owner && f.field === target.field)?.contexts ?? [];
    let feedback: string | null = null;
    let landed = false;
    let notes: string | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      console.log(`  round ${round}: asking ${provider.name}…`);
      const response = await provider.complete(systemPrompt, buildUserPrompt(target, contexts, sources, feedback));

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

      // Verified: land the compiled classes into the working jar.
      const nextJar = path.join(workDir, "patched.jar");
      const { replaced, added } = await updateJar(workingJar, gate.outDir, nextJar);
      workingJar = nextJar;
      patchedCount++;
      landed = true;
      notes = patch.notes;
      results.push({ field: fieldLabel, status: "patched", detail: `${patch.edits.length} edit(s), ${replaced + added} class file(s) updated`, rounds: round, classes, notes });
      console.log(`  ✔ patched in round ${round}: ${patch.notes ?? `${patch.edits.length} edits`}\n`);
      break;
    }

    if (!landed) {
      results.push({ field: fieldLabel, status: "failed", detail: feedback?.slice(0, 400) ?? "exhausted rounds", rounds: maxRounds, classes });
      console.log(`  ✖ gave up after ${maxRounds} rounds\n`);
    }
  }

  // Stage the Tier 3 artifact separately from the Tier 1+2 jar.
  let finalJar: string | null = null;
  if (patchedCount > 0) {
    finalJar = path.join(OUT_DIR, `${path.basename(jarPath, ".jar")}-folia-t3.jar`);
    fs.copyFileSync(workingJar, finalJar);

    // Verification: re-scan (no reintroduced blockers) + re-analyze.
    const finalIndex = await indexJar(finalJar);
    const postScan = scan(finalIndex, loadCatalog(), { ignorePrefixes: [outcome.targetPrefix] });
    const blockers = postScan.findings.filter((f) => f.severity === "blocker").length;
    const postAnalysis = analyzeSharedState(finalIndex, [outcome.targetPrefix]);
    const stillHigh = postAnalysis.findings.filter(
      (f) => f.risk === "high" && results.some((r) => r.status === "patched" && r.field === `${f.owner.replaceAll("/", ".")}.${f.field}`),
    );
    console.log(`Verification: ${blockers} scheduler blockers, ${stillHigh.length} patched field(s) still flagged high-risk`);
  }

  return { outcome, finalJar, results };
}
