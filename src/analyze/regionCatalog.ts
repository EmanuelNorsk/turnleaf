import fs from "node:fs";
import path from "node:path";
import type { RegionCatalog } from "../types.js";
import { RULES_DIR } from "../env.js";

const CATALOG_PATH = path.join(RULES_DIR, "region-guarded.generated.json");

export interface RegionMatcher {
  loaded: boolean;
  generatedFrom: string;
  count: number;
  /** Is owner.name(desc) a region-locked Bukkit API method? */
  isGuarded(owner: string, name: string, desc: string): boolean;
}

/**
 * Loads the region-locked API catalog mined from the Folia server jar. Absent
 * catalog (never mined) yields a no-op matcher, so analysis still runs.
 */
export function loadRegionCatalog(): RegionMatcher {
  if (!fs.existsSync(CATALOG_PATH)) {
    return { loaded: false, generatedFrom: "(not mined)", count: 0, isGuarded: () => false };
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as RegionCatalog;
  // name+desc -> prefixes that guard it.
  const byKey = new Map<string, string[]>();
  for (const m of catalog.methods) {
    const key = m.name + m.desc;
    const arr = byKey.get(key);
    if (arr) arr.push(m.prefix);
    else byKey.set(key, [m.prefix]);
  }
  return {
    loaded: true,
    generatedFrom: catalog.generatedFrom,
    count: catalog.methods.length,
    isGuarded(owner, name, desc) {
      const prefixes = byKey.get(name + desc);
      return prefixes !== undefined && prefixes.some((p) => owner.startsWith(p));
    },
  };
}
