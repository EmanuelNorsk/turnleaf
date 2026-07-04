import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RULES_DIR, SHIM_JAR } from "../env.js";

/**
 * Identity of the conversion pipeline: hash of everything that determines what
 * a conversion produces (shim runtime + rule catalogs). Stamped into every
 * converted jar so the app can tell when a jar was made by an older pipeline
 * and should be re-converted.
 */
let cached: string | null = null;

export function pipelineHash(): string {
  if (cached) return cached;
  const h = crypto.createHash("sha256");
  const parts = [
    SHIM_JAR,
    path.join(RULES_DIR, "catalog.json"),
    path.join(RULES_DIR, "region-guarded.generated.json"),
    path.join(RULES_DIR, "region-subtypes.generated.json"),
  ];
  for (const p of parts) {
    h.update(path.basename(p));
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  cached = h.digest("hex").slice(0, 16);
  return cached;
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Parse the key=value lines of a jar's folia-on-demand.properties stamp. */
export function parseStamp(text: string | null): Record<string, string> | null {
  if (!text) return null;
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}
