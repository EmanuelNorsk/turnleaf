import fs from "node:fs";
import path from "node:path";
import type { EngineIndex, RedirectSpec } from "../types.js";
import { RULES_DIR } from "../env.js";
import { subclassesOf } from "../scan/scanner.js";
import { dropFirstParam, firstParamObject } from "./descriptor.js";

const SUBTYPES_PATH = path.join(RULES_DIR, "region-subtypes.generated.json");

let subtypeMap: Record<string, string[]> | null = null;

/** All Bukkit sub-interfaces of `iface` (so a supertype-declared shim matches subtype call sites). */
function subtypesOf(iface: string): string[] {
  if (subtypeMap === null) {
    subtypeMap = fs.existsSync(SUBTYPES_PATH) ? JSON.parse(fs.readFileSync(SUBTYPES_PATH, "utf8")) : {};
  }
  return subtypeMap![iface] ?? [];
}

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_SYNTHETIC = 0x1000;

const BUKKIT_RUNNABLE = "org/bukkit/scheduler/BukkitRunnable";

/** Base receiver types matched by package prefix (any subtype call site). */
const BASE_PREFIX_RECEIVERS = new Set([
  "org/bukkit/entity/Entity",
  "org/bukkit/entity/LivingEntity",
  "org/bukkit/entity/Damageable",
  "org/bukkit/entity/HumanEntity",
  "org/bukkit/inventory/Inventory",
  "org/bukkit/block/BlockState",
]);

/**
 * Derives the rewrite table from the shim jar itself: every public static
 * method on Shim mirrors an original instance method with the receiver
 * prepended, so the receiver type tells us which call sites to redirect.
 * Only calls the shim actually implements are ever rewritten.
 */
export function buildRedirects(
  shimIndex: EngineIndex,
  pluginIndex: EngineIndex,
  relocatedShimOwner: string,
  shimClassInternal = "dev/foliaondemand/shim/Shim",
): { redirects: RedirectSpec[]; skipped: string[] } {
  const shimClass = shimIndex.classes.find((c) => c.name === shimClassInternal);
  // ShimGenerated may be absent (never mined) — that's fine, no extra redirects.
  if (!shimClass) return { redirects: [], skipped: [] };

  const runnableSubclasses = subclassesOf(pluginIndex, BUKKIT_RUNNABLE);
  const declares = (className: string, name: string, desc: string): boolean => {
    const cls = pluginIndex.classes.find((c) => c.name === className);
    return cls?.methods.some((m) => m.name === name && m.desc === desc) ?? false;
  };

  const redirects: RedirectSpec[] = [];
  const skipped: string[] = [];

  for (const m of shimClass.methods) {
    if (!(m.access & ACC_PUBLIC) || !(m.access & ACC_STATIC) || m.access & ACC_SYNTHETIC) continue;
    if (m.name === "<clinit>") continue;

    const receiver = firstParamObject(m.desc);
    if (!receiver) {
      skipped.push(`${m.name}${m.desc} (no object receiver)`);
      continue;
    }
    const origDesc = dropFirstParam(m.desc);

    let owners: string[] | null = null;
    let ownerPrefix: string | null = null;

    if (receiver === "org/bukkit/scheduler/BukkitScheduler") {
      owners = [receiver];
    } else if (receiver === BUKKIT_RUNNABLE) {
      // Include the plugin's own BukkitRunnable subclasses as owners, but never
      // hijack a method the subclass overrides itself.
      const subOwners = [...runnableSubclasses].filter((c) => !declares(c, m.name, origDesc));
      owners = [receiver, ...subOwners];
    } else if (BASE_PREFIX_RECEIVERS.has(receiver)) {
      // Base types (Entity, Inventory, BlockState, …) match any subtype call
      // site by package prefix, since the concrete receiver type varies.
      ownerPrefix = receiver.slice(0, receiver.lastIndexOf("/") + 1);
    } else if (receiver.startsWith("org/bukkit/")) {
      // Specific types (ExperienceOrb, InventoryView, Server, …) match by exact
      // owner plus every sub-interface — so a method declared on a supertype
      // (AbstractArrow.setPickupStatus) still matches a subtype call (Arrow).
      // Exact matches beat prefix matches in the engine.
      owners = [receiver, ...subtypesOf(receiver)];
    } else {
      skipped.push(`${m.name}${m.desc} (unknown receiver ${receiver})`);
      continue;
    }

    const shortReceiver = receiver.slice(receiver.lastIndexOf("/") + 1);
    redirects.push({
      id: `${shortReceiver}.${m.name}${origDesc}`,
      owners,
      ownerPrefix,
      name: m.name,
      desc: origDesc,
      targetOwner: relocatedShimOwner,
      targetName: m.name,
      targetDesc: m.desc,
      staticCall: false,
    });
  }

  return { redirects, skipped };
}

/**
 * Static-call redirects: Bukkit.* methods that only work on a region thread
 * under Folia. Unlike instance redirects these are declared explicitly (there's
 * no receiver to key off), and the shim method's descriptor equals the
 * original's. Targets live in the relocated ShimStatic class.
 */
const STATIC_REDIRECTS: { owner: string; name: string; desc: string }[] = [
  { owner: "org/bukkit/Bukkit", name: "getCurrentTick", desc: "()I" },
  {
    owner: "org/bukkit/Bukkit",
    name: "dispatchCommand",
    desc: "(Lorg/bukkit/command/CommandSender;Ljava/lang/String;)Z",
  },
];

export function buildStaticRedirects(shimStaticOwner: string): RedirectSpec[] {
  return STATIC_REDIRECTS.map((r) => ({
    id: `${r.owner.slice(r.owner.lastIndexOf("/") + 1)}.${r.name}${r.desc} [static]`,
    owners: [r.owner],
    ownerPrefix: null,
    name: r.name,
    desc: r.desc,
    targetOwner: shimStaticOwner,
    targetName: r.name,
    targetDesc: r.desc,
    staticCall: true,
  }));
}
