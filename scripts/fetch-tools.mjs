// Bootstrap the gitignored tools/ folder on a fresh machine (CI or a new dev
// clone) and keep every dependency on its newest stable release:
//
//   1. resolve the latest stable version of each Java dependency + Maven plugin
//      and write them to .mvn/maven.config as -D overrides (Maven applies that
//      file to every build, so `mvn package` picks them up automatically);
//   2. download the Vineflower decompiler;
//   3. generate the Tier 3 compile-gate classpath from shim-runtime's Maven
//      dependencies.
//
//   node scripts/fetch-tools.mjs [--force] [--offline] [--out <dir>]
//
// Re-run it any time to move to the newest versions; work is only redone when
// a version actually changed (or with --force). --offline skips resolution and
// keeps whatever .mvn/maven.config already says (or the pom.xml defaults).
// The versions used are recorded in tools/dependency-versions.json.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CENTRAL = "https://repo1.maven.org/maven2";
const PAPERMC = "https://repo.papermc.io/repository/maven-public";
const TCODED = "https://repo.tcoded.com/releases";

/**
 * What to keep current. `maxMajor` caps a dependency whose next major needs a
 * different toolchain (Maven 4.x plugins require Maven 4); `stable` decides
 * which published versions count as releases.
 */
const DEPENDENCIES = [
  { property: "asm.version", repo: CENTRAL, coords: "org/ow2/asm/asm" },
  { property: "jackson.version", repo: CENTRAL, coords: "com/fasterxml/jackson/core/jackson-databind" },
  // PaperMC's metadata marks alphas as "release" — only "-stable" builds count.
  { property: "paper-api.version", repo: PAPERMC, coords: "io/papermc/paper/paper-api", stable: (v) => v.endsWith("-stable") },
  { property: "folialib.version", repo: TCODED, coords: "com/tcoded/FoliaLib" },
  { property: "maven-compiler-plugin.version", repo: CENTRAL, coords: "org/apache/maven/plugins/maven-compiler-plugin", maxMajor: 3 },
  { property: "maven-jar-plugin.version", repo: CENTRAL, coords: "org/apache/maven/plugins/maven-jar-plugin", maxMajor: 3 },
  { property: "maven-shade-plugin.version", repo: CENTRAL, coords: "org/apache/maven/plugins/maven-shade-plugin", maxMajor: 3 },
  { property: "maven-dependency-plugin.version", repo: CENTRAL, coords: "org/apache/maven/plugins/maven-dependency-plugin", maxMajor: 3 },
  { property: "vineflower.version", repo: CENTRAL, coords: "org/vineflower/vineflower" },
];

/**
 * Hold a dependency back when a new release breaks the build, e.g.
 *   "paper-api.version": "26.3.build.218-stable"
 * Pinned entries skip resolution entirely.
 */
const PINS = {};

/** Fallback when resolution fails and nothing was resolved before. */
const VINEFLOWER_FALLBACK = "1.12.0";

/** Static Maven flags that must survive every rewrite of .mvn/maven.config. */
const MAVEN_FLAGS = ["-Daether.remoteRepositoryFilter.prefixes=false"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const offline = args.includes("--offline");
const outIdx = args.indexOf("--out");
const toolsDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, "tools");
const mavenConfig = path.join(root, ".mvn", "maven.config");
const versionsFile = path.join(toolsDir, "dependency-versions.json");

fs.mkdirSync(toolsDir, { recursive: true });

const isPreRelease = (v) => /[-.](alpha|beta|rc|cr|milestone|snapshot|pre|ea|m)(\d|[-.]|$)/i.test(v);
const numbers = (v) => (v.match(/\d+/g) ?? []).map(Number);
function compare(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function latestStable(dep) {
  const res = await fetch(`${dep.repo}/${dep.coords}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1].trim())
    // Versions end up in .mvn/maven.config and CI commit messages — only
    // accept plain version strings from third-party metadata.
    .filter((v) => /^[\w.+-]+$/.test(v))
    .filter(dep.stable ?? ((v) => !isPreRelease(v)))
    .filter((v) => dep.maxMajor === undefined || numbers(v)[0] <= dep.maxMajor);
  if (versions.length === 0) throw new Error("no stable versions listed");
  return versions.sort(compare).at(-1);
}

/** Current overrides in .mvn/maven.config, as { property: version }. */
function readMavenConfig() {
  if (!fs.existsSync(mavenConfig)) return {};
  const out = {};
  for (const m of fs.readFileSync(mavenConfig, "utf8").matchAll(/-D([\w.-]+\.version)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

// 1. Resolve versions.
const previous = readMavenConfig();
const resolved = { ...previous };
if (offline) {
  console.log("fetch-tools: --offline, keeping current dependency versions");
} else {
  console.log("fetch-tools: resolving latest stable dependency versions…");
  await Promise.all(
    DEPENDENCIES.map(async (dep) => {
      if (PINS[dep.property]) {
        resolved[dep.property] = PINS[dep.property];
        return;
      }
      try {
        resolved[dep.property] = await latestStable(dep);
      } catch (e) {
        const kept = resolved[dep.property] ?? "pom.xml default";
        console.warn(`fetch-tools: could not resolve ${dep.coords} (${e.message}) — keeping ${kept}`);
      }
    }),
  );
}
for (const dep of DEPENDENCIES) {
  const [was, now] = [previous[dep.property], resolved[dep.property]];
  if (now && was !== now) console.log(`fetch-tools:   ${dep.property.replace(/\.version$/, "")}: ${was ?? "default"} → ${now}`);
}
const changed = JSON.stringify(previous) !== JSON.stringify(resolved);
if (changed || !fs.existsSync(mavenConfig)) {
  const lines = [...MAVEN_FLAGS, ...Object.entries(resolved).sort().map(([k, v]) => `-D${k}=${v}`)];
  fs.mkdirSync(path.dirname(mavenConfig), { recursive: true });
  fs.writeFileSync(mavenConfig, lines.join("\n") + "\n");
  console.log("fetch-tools: .mvn/maven.config updated");
} else {
  console.log("fetch-tools: dependency versions unchanged");
}

// 2. Vineflower.
const vineflowerVersion = resolved["vineflower.version"] ?? VINEFLOWER_FALLBACK;
const vineflower = path.join(toolsDir, "vineflower.jar");
let recorded = {};
try {
  recorded = JSON.parse(fs.readFileSync(versionsFile, "utf8"));
} catch {
  // first run
}
if (force || !fs.existsSync(vineflower) || recorded["vineflower.version"] !== vineflowerVersion) {
  console.log(`fetch-tools: downloading Vineflower ${vineflowerVersion}…`);
  const url = `${CENTRAL}/org/vineflower/vineflower/${vineflowerVersion}/vineflower-${vineflowerVersion}.jar`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Vineflower download failed: HTTP ${res.status}`);
  fs.writeFileSync(vineflower, Buffer.from(await res.arrayBuffer()));
  console.log(`fetch-tools: ${vineflower} (${(fs.statSync(vineflower).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.log("fetch-tools: vineflower.jar already current");
}

// 3. Compile-gate classpath: paper-api + transitives + FoliaLib, resolved by
// Maven from shim-runtime's dependencies (absolute .m2 paths; scripts/stage.mjs
// rewrites them to relative ones when packaging the app). Maven reads the
// versions from .mvn/maven.config written above.
const cpFile = path.join(toolsDir, "paper-classpath.txt");
const cpStale = ["paper-api.version", "folialib.version"].some((k) => recorded[k] !== resolved[k]);
if (force || !fs.existsSync(cpFile) || cpStale) {
  console.log("fetch-tools: generating paper-classpath.txt via Maven…");
  const mvnArgs = ["-q", "-pl", "shim-runtime", "dependency:build-classpath", `"-Dmdep.outputFile=${cpFile}"`];
  if (process.platform === "win32") {
    // mvn is a .cmd shim on Windows — needs a shell; pass one quoted string.
    execSync(`mvn ${mvnArgs.join(" ")}`, { cwd: root, stdio: "inherit" });
  } else {
    execFileSync("mvn", mvnArgs.map((a) => a.replaceAll('"', "")), { cwd: root, stdio: "inherit" });
  }
  const entries = fs.readFileSync(cpFile, "utf8").trim().split(path.delimiter).filter(Boolean);
  console.log(`fetch-tools: classpath written (${entries.length} entries)`);
} else {
  console.log("fetch-tools: paper-classpath.txt already current");
}

const record = Object.fromEntries(Object.entries({ ...resolved, "vineflower.version": vineflowerVersion }).sort());
fs.writeFileSync(versionsFile, JSON.stringify(record, null, 2) + "\n");
console.log(`fetch-tools: done — versions recorded in ${path.relative(root, versionsFile)}`);
