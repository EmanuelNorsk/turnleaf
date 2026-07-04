// Stage the self-contained app home into dist/home/.
//
// The staged tree mirrors the dev layout exactly (src/env.ts paths are all
// relative to ROOT), so the packaged launcher just sets FOD_HOME to a copy of
// this tree and everything resolves. Runtime prerequisites: Node + Java only.
//
//   dist/home/
//     dist/folia.cjs                      single-file CLI+GUI (no node_modules)
//     engine/target/engine.jar            ASM engine daemon
//     shim-runtime/target/shim-runtime.jar
//     tools/vineflower.jar
//     tools/paper-libs/*.jar              Tier 3 compile-gate classpath
//     tools/paper-classpath.txt           entries relative to tools/
//     src/rules/*.json
//     src/gui/public/*
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.join(root, "dist", "home");

function fail(msg) {
  console.error(`stage: ${msg}`);
  process.exit(1);
}

function copy(srcRel, destRel = srcRel) {
  const src = path.join(root, srcRel);
  if (!fs.existsSync(src)) fail(`missing ${srcRel} — build it first`);
  const dest = path.join(home, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// Fresh bundle every stage — it's fast and removes a stale-artifact failure mode.
console.log("stage: bundling CLI…");
execFileSync(process.execPath, [path.join(root, "scripts", "bundle.mjs")], { stdio: "inherit" });

fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });

copy(path.join("dist", "folia.cjs"));
copy(path.join("engine", "target", "engine.jar"));
copy(path.join("shim-runtime", "target", "shim-runtime.jar"));
copy(path.join("tools", "vineflower.jar"));
copy(path.join("src", "rules"));
copy(path.join("src", "gui", "public"));

// Tier 3 compile-gate classpath: ship every jar and rewrite the classpath
// file with tools/-relative entries (readPaperClasspath resolves them).
const cpFile = path.join(root, "tools", "paper-classpath.txt");
if (!fs.existsSync(cpFile)) fail("missing tools/paper-classpath.txt");
const entries = fs.readFileSync(cpFile, "utf8").trim().split(path.delimiter).filter(Boolean);
const relEntries = [];
for (const entry of entries) {
  if (!fs.existsSync(entry)) fail(`classpath entry missing: ${entry}`);
  const name = path.basename(entry);
  fs.mkdirSync(path.join(home, "tools", "paper-libs"), { recursive: true });
  fs.cpSync(entry, path.join(home, "tools", "paper-libs", name));
  relEntries.push(path.join("paper-libs", name));
}
fs.writeFileSync(path.join(home, "tools", "paper-classpath.txt"), relEntries.join(path.delimiter));

// Writable dirs the app expects; folia/ is where the user drops a server jar
// to enable the verify (boot-test) feature.
for (const d of ["out", "reports", "uploads", "folia"]) {
  fs.mkdirSync(path.join(home, d), { recursive: true });
}
fs.writeFileSync(
  path.join(home, "folia", "README.txt"),
  "Drop a Folia server jar in this folder to enable the Verify (boot test) feature.\r\n",
);

const size = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
};
console.log(`stage: done — ${home} (${(size(home) / 1024 / 1024).toFixed(1)} MB)`);
