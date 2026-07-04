import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { EngineIndex, MineResult, TransformJob, TransformResult } from "../types.js";
import { ENGINE_JAR } from "../env.js";

const execFileAsync = promisify(execFile);

/**
 * Long-lived engine daemon: the JVM starts once per session and takes jobs as
 * newline-delimited JSON over stdin (one JSON response line per request).
 * Batch runs and the GUI pay JVM startup a single time; the JIT warms up
 * across jobs.
 */
interface Daemon {
  child: ChildProcess;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
}

let daemon: Daemon | null = null;

function ensureDaemon(): Daemon {
  if (daemon && daemon.child.exitCode === null && !daemon.child.killed) return daemon;
  if (!fs.existsSync(ENGINE_JAR)) {
    throw new Error(`Engine jar not found at ${ENGINE_JAR} — build it first with: mvn package`);
  }

  const child = spawn("java", ["-jar", ENGINE_JAR, "daemon"], { stdio: ["pipe", "pipe", "inherit"] });
  const d: Daemon = { child, pending: new Map(), nextId: 1 };

  // Responses can be tens of MB on one line (index of a large jar) — collect
  // raw chunks and concat once per line; string += per chunk is quadratic.
  let chunks: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) {
        if (start < chunk.length) chunks.push(chunk.subarray(start));
        break;
      }
      chunks.push(chunk.subarray(start, nl));
      const line = Buffer.concat(chunks).toString("utf8").trim();
      chunks = [];
      start = nl + 1;
      if (!line) continue;
      const msg = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
      const req = d.pending.get(msg.id);
      if (req) {
        d.pending.delete(msg.id);
        if (msg.ok) req.resolve(msg.result);
        else req.reject(new Error(`engine: ${msg.error}`));
      }
    }
  });
  child.on("exit", () => {
    for (const req of d.pending.values()) req.reject(new Error("engine daemon exited unexpectedly"));
    d.pending.clear();
    if (daemon === d) daemon = null;
  });

  daemon = d;
  return d;
}

function engineRequest<T>(cmd: string, payload: Record<string, unknown>): Promise<T> {
  const d = ensureDaemon();
  const id = d.nextId++;
  return new Promise<T>((resolve, reject) => {
    d.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    d.child.stdin!.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
  });
}

/**
 * One-shot Folia-jar mine. Run directly (not via the daemon) with a large heap,
 * since building the whole-server call graph is memory-heavy.
 */
export async function mineFolia(jars: string[], maxDepth: number): Promise<MineResult> {
  if (!fs.existsSync(ENGINE_JAR)) {
    throw new Error(`Engine jar not found at ${ENGINE_JAR} — build it first with: mvn package`);
  }
  const { stdout } = await execFileAsync(
    "java",
    ["-Xmx3g", "-jar", ENGINE_JAR, "minefolia", String(maxDepth), ...jars],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as MineResult;
}

/** Kill the daemon (CLI calls this on exit; the GUI keeps it alive). */
export function shutdownEngine(): void {
  daemon?.child.kill();
  daemon = null;
}

process.on("exit", () => daemon?.child.kill());

export async function indexJar(jarPath: string): Promise<EngineIndex> {
  return engineRequest<EngineIndex>("index", { jar: path.resolve(jarPath) });
}

export async function transformJar(job: TransformJob): Promise<TransformResult> {
  return engineRequest<TransformResult>("transform", { job });
}

/** Reads only plugin.yml + our audit stamp from each jar — cheap enough for a whole library. */
export async function jarMetas(
  jarPaths: string[],
): Promise<{ jar: string; pluginYml: string | null; properties: string | null }[]> {
  return engineRequest("meta", { jars: jarPaths.map((p) => path.resolve(p)) });
}

/** Extracts the given classes (plus inner classes) from a jar into outDir. */
export async function extractClasses(jarPath: string, outDir: string, classes: string[]): Promise<void> {
  await engineRequest("extract", { jar: path.resolve(jarPath), outDir: path.resolve(outDir), classes: classes.join(",") });
}

/** Copies inputJar to outputJar, replacing/adding .class files found under classesDir. */
export async function updateJar(
  inputJar: string,
  classesDir: string,
  outputJar: string,
): Promise<{ replaced: number; added: number }> {
  return engineRequest("updatejar", {
    inputJar: path.resolve(inputJar),
    classesDir: path.resolve(classesDir),
    outputJar: path.resolve(outputJar),
  });
}
