import fs from "node:fs";
import path from "node:path";
import { analyzeSharedState } from "../analyze/sharedState.js";
import { indexJar, transformJar } from "../engine/client.js";
import { loadCatalog, parsePluginMeta, scan } from "../scan/scanner.js";
import type { CollectionFixSpec, ConvertOutcome, Tier3Target, TransformJob } from "../types.js";
import { OUT_DIR, SHIM_JAR, VERSION } from "../env.js";
import { buildRedirects, buildStaticRedirects } from "./redirects.js";
import { pipelineHash, sha256File } from "./pipeline.js";

const FIXABLE_IFACE_DESCS = new Set(["Ljava/util/Map;", "Ljava/util/Set;", "Ljava/util/List;"]);

const SHIM_PREFIX = "dev/foliaondemand/shim";

function relocationTarget(mainClass: string | undefined): string {
  if (mainClass && mainClass.includes(".")) {
    const pkg = mainClass.slice(0, mainClass.lastIndexOf(".")).replaceAll(".", "/");
    return `${pkg}/foliashim`;
  }
  return "foliaondemand/injected/foliashim";
}

export interface ConvertOptions {
  outJar?: string;
  /** Tier 2 concurrency fixes (default on). */
  t2?: boolean;
}

export async function convert(jarPath: string, options: ConvertOptions = {}): Promise<ConvertOutcome> {
  if (!fs.existsSync(SHIM_JAR)) {
    throw new Error(`Shim runtime not built (${SHIM_JAR}) — run: mvn package`);
  }
  const catalog = loadCatalog();

  // Stage A+B: index and scan the input. The shim package is excluded up
  // front so re-converting an already-converted jar doesn't count the old
  // injected shim's own internals as the plugin's blockers.
  const index = await indexJar(jarPath);
  const targetPrefix = relocationTarget(parsePluginMeta(index.pluginYml)?.main);
  const preScan = scan(index, catalog, { ignorePrefixes: [targetPrefix] });

  // Build the redirect table from the shim jar's own signatures.
  const shimIndex = await indexJar(SHIM_JAR);
  const shim = buildRedirects(shimIndex, index, `${targetPrefix}/Shim`, "dev/foliaondemand/shim/Shim");
  const generated = buildRedirects(shimIndex, index, `${targetPrefix}/ShimGenerated`, "dev/foliaondemand/shim/ShimGenerated");
  const redirects = [...shim.redirects, ...generated.redirects, ...buildStaticRedirects(`${targetPrefix}/ShimStatic`)];
  const skipped = [...shim.skipped, ...generated.skipped];

  // Stage E (Tier 2): shared-state analysis decides which fields the engine
  // should try to upgrade; the engine only touches provably frame-safe sites.
  // A region-mutation is "handled" if a shim redirect will rewrite that exact
  // call — those are auto-fixed, so don't warn about them post-conversion.
  // (Includes static redirects like Bukkit.dispatchCommand.)
  const handledByShim = (owner: string, name: string, desc: string): boolean =>
    redirects.some(
      (r) =>
        r.name === name &&
        r.desc === desc &&
        ((r.owners?.includes(owner) ?? false) || (r.ownerPrefix ? owner.startsWith(r.ownerPrefix) : false)),
    );

  const collectionFixes: CollectionFixSpec[] = [];
  const tier3Targets: Tier3Target[] = [];
  let regionViolations: ConvertOutcome["regionViolations"] = [];
  if (options.t2 !== false) {
    const analysis = analyzeSharedState(index);
    regionViolations = analysis.regionViolations.filter(
      (v) => v.mutation && !handledByShim(v.call.owner, v.call.name, v.call.desc),
    );
    for (const f of analysis.findings) {
      if (f.risk === "low") continue;
      if (FIXABLE_IFACE_DESCS.has(f.desc)) {
        collectionFixes.push({ fieldOwner: f.owner, fieldName: f.field });
      } else if (f.risk === "high") {
        tier3Targets.push({ owner: f.owner, field: f.field, desc: f.desc });
      }
    }
  }

  // Stage C+E: run the engine transform (redirects + shim + Tier 2 fixes).
  const output =
    options.outJar ?? path.join(OUT_DIR, `${path.basename(jarPath, ".jar")}-folia.jar`);
  const job: TransformJob = {
    inputJar: path.resolve(jarPath),
    outputJar: path.resolve(output),
    redirects,
    injectJar: SHIM_JAR,
    relocation: { fromPrefix: SHIM_PREFIX, toPrefix: targetPrefix },
    setFoliaSupported: true,
    collectionFixes,
    stamp: {
      "converter": `turnleaf ${VERSION}`,
      "converter-version": VERSION,
      "pipeline-hash": pipelineHash(),
      "original-name": path.basename(jarPath),
      "original-sha256": sha256File(jarPath),
      "converted-at": new Date().toISOString(),
      "folialib": "0.5.2",
      "tier2-fixes": String(options.t2 !== false),
      "shim-package": targetPrefix.replaceAll("/", "."),
    },
  };
  const result = await transformJar(job);

  // Stage D (static part): the output must re-index cleanly, and a re-scan —
  // ignoring the injected shim package — should show no remaining blockers.
  const outIndex = await indexJar(job.outputJar);
  const postScan = scan(outIndex, catalog, { ignorePrefixes: [targetPrefix] });

  return {
    jarPath,
    outputJar: job.outputJar,
    targetPrefix,
    preScan,
    postScan,
    result,
    skippedShimMethods: skipped,
    tier3Targets,
    regionViolations,
  };
}
