import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  Catalog,
  EngineIndex,
  Finding,
  Invocation,
  PluginMeta,
  Rule,
  ScanResult,
} from "../types.js";
import { RULES_DIR } from "../env.js";

const CATALOG_PATH = path.join(RULES_DIR, "catalog.json");

export function loadCatalog(): Catalog {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

/** Classes in the jar whose superclass chain (within the jar) reaches `target`. */
export function subclassesOf(index: EngineIndex, target: string): Set<string> {
  const superOf = new Map<string, string | null>(index.classes.map((c) => [c.name, c.superName]));
  const memo = new Map<string, boolean>();

  const reaches = (name: string | null | undefined): boolean => {
    if (!name) return false;
    if (name === target) return true;
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    memo.set(name, false); // cycle guard
    const result = reaches(superOf.get(name));
    memo.set(name, result);
    return result;
  };

  const set = new Set<string>();
  for (const c of index.classes) {
    if (reaches(c.superName)) set.add(c.name);
  }
  return set;
}

function matches(
  inv: Invocation,
  rule: Rule,
  extraOwners: Set<string> | undefined,
  declares: (className: string, name: string, desc: string) => boolean,
): boolean {
  const m = rule.match;
  if (m.owners || m.ownerPrefix) {
    const direct = m.owners?.includes(inv.owner) ?? false;
    const prefix = m.ownerPrefix ? inv.owner.startsWith(m.ownerPrefix) : false;
    // A subclass-owned call site only dispatches to the base implementation if
    // the subclass does NOT override the method itself (same exclusion the
    // Tier 1 redirect applies — keeps scan and rewrite consistent).
    const viaSubclass =
      !direct && (extraOwners?.has(inv.owner) ?? false) && !declares(inv.owner, inv.name, inv.desc);
    if (!direct && !prefix && !viaSubclass) return false;
  }
  if (m.names && !m.names.includes(inv.name)) return false;
  if (m.descContains && !inv.desc.includes(m.descContains)) return false;
  return true;
}

const asNameList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function parsePluginMeta(pluginYml: string | null): PluginMeta | null {
  if (!pluginYml) return null;
  try {
    const doc = YAML.parse(pluginYml) as Record<string, unknown>;
    return {
      name: typeof doc.name === "string" ? doc.name : undefined,
      version: doc.version !== undefined ? String(doc.version) : undefined,
      main: typeof doc.main === "string" ? doc.main : undefined,
      apiVersion: doc["api-version"] !== undefined ? String(doc["api-version"]) : undefined,
      foliaSupported: doc["folia-supported"] === true,
      depend: asNameList(doc.depend),
      softDepend: asNameList(doc.softdepend),
    };
  } catch {
    return { foliaSupported: false };
  }
}

export interface ScanOptions {
  /** Class-name prefixes to skip — e.g. the injected shim package on a re-scan. */
  ignorePrefixes?: string[];
}

export function scan(index: EngineIndex, catalog: Catalog, options: ScanOptions = {}): ScanResult {
  const ignore = options.ignorePrefixes ?? [];

  // Precompute subclass sets once per referenced base type.
  const subclassSets = new Map<string, Set<string>>();
  for (const rule of catalog.rules) {
    const base = rule.extendOwnersWithSubclassesOf;
    if (base && !subclassSets.has(base)) {
      subclassSets.set(base, subclassesOf(index, base));
    }
  }

  const declared = new Map<string, Set<string>>(
    index.classes.map((c) => [c.name, new Set(c.methods.map((m) => m.name + m.desc))]),
  );
  const declares = (className: string, name: string, desc: string): boolean =>
    declared.get(className)?.has(name + desc) ?? false;

  const findings: Finding[] = [];
  let methodCount = 0;
  let invocationCount = 0;

  for (const cls of index.classes) {
    if (ignore.some((p) => cls.name.startsWith(p))) continue;
    for (const method of cls.methods) {
      methodCount++;
      for (const inv of method.invocations) {
        invocationCount++;
        for (const rule of catalog.rules) {
          const extra = rule.extendOwnersWithSubclassesOf
            ? subclassSets.get(rule.extendOwnersWithSubclassesOf)
            : undefined;
          if (matches(inv, rule, extra, declares)) {
            findings.push({
              ruleId: rule.id,
              severity: rule.severity,
              title: rule.title,
              className: cls.name,
              method: `${method.name}${method.desc}`,
              invocation: inv,
            });
          }
        }
      }
    }
  }

  return {
    jar: index.jar,
    plugin: parsePluginMeta(index.pluginYml),
    findings,
    classCount: index.classes.length,
    methodCount,
    invocationCount,
    engineWarnings: index.warnings,
  };
}
