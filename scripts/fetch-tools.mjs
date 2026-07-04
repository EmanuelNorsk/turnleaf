// Bootstrap the gitignored tools/ folder on a fresh machine (CI or a new dev
// clone): download the Vineflower decompiler and generate the Tier 3
// compile-gate classpath from shim-runtime's Maven dependencies.
//
//   node scripts/fetch-tools.mjs [--force] [--out <dir>]
//
// Idempotent: existing files are kept unless --force is given.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VINEFLOWER_VERSION = "1.12.0";
const VINEFLOWER_URL = `https://github.com/Vineflower/vineflower/releases/download/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const outIdx = args.indexOf("--out");
const toolsDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, "tools");

fs.mkdirSync(toolsDir, { recursive: true });

// 1. Vineflower.
const vineflower = path.join(toolsDir, "vineflower.jar");
if (force || !fs.existsSync(vineflower)) {
  console.log(`fetch-tools: downloading Vineflower ${VINEFLOWER_VERSION}…`);
  const res = await fetch(VINEFLOWER_URL);
  if (!res.ok) throw new Error(`Vineflower download failed: HTTP ${res.status}`);
  fs.writeFileSync(vineflower, Buffer.from(await res.arrayBuffer()));
  console.log(`fetch-tools: ${vineflower} (${(fs.statSync(vineflower).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.log("fetch-tools: vineflower.jar already present");
}

// 2. Compile-gate classpath: paper-api + transitives + FoliaLib, resolved by
// Maven from shim-runtime's dependencies (absolute .m2 paths; scripts/stage.mjs
// rewrites them to relative ones when packaging the app).
const cpFile = path.join(toolsDir, "paper-classpath.txt");
if (force || !fs.existsSync(cpFile)) {
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
  console.log("fetch-tools: paper-classpath.txt already present");
}

console.log("fetch-tools: done");
