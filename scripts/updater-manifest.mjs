// Build latest.json — the feed the desktop app's auto-updater reads — from the
// signed installers CI produced. Every installer needs its .sig next to it
// (written by `tauri build` when TAURI_SIGNING_PRIVATE_KEY is set).
//
//   node scripts/updater-manifest.mjs <installersDir> --tag v1.2.3 --repo owner/name
//
// The app looks up "{os}-{arch}-{bundle}" first, then "{os}-{arch}", so each
// installer is listed under its bundle key and the first one per OS also
// under the plain key.
import fs from "node:fs";
import path from "node:path";

const [dir, ...rest] = process.argv.slice(2);
const opt = (name) => rest[rest.indexOf(name) + 1];
const tag = opt("--tag");
const repo = opt("--repo");
if (!dir || !tag || !repo || !rest.includes("--tag") || !rest.includes("--repo")) {
  console.error("usage: updater-manifest.mjs <installersDir> --tag vX.Y.Z --repo owner/name");
  process.exit(1);
}

// Installer suffix → updater platform keys. macOS runners are Apple Silicon.
const KINDS = [
  { suffix: "-setup.exe", keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { suffix: ".AppImage", keys: ["linux-x86_64-appimage", "linux-x86_64"] },
  { suffix: ".deb", keys: ["linux-x86_64-deb"] },
  { suffix: ".app.tar.gz", keys: ["darwin-aarch64-app", "darwin-aarch64"] },
];

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dir);

const platforms = {};
for (const file of files) {
  const kind = KINDS.find((k) => file.endsWith(k.suffix));
  if (!kind || !fs.existsSync(`${file}.sig`)) continue;
  const entry = {
    signature: fs.readFileSync(`${file}.sig`, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(path.basename(file))}`,
  };
  for (const key of kind.keys) platforms[key] ??= entry;
}

if (Object.keys(platforms).length === 0) {
  console.warn("updater-manifest: no signed installers found — skipping latest.json (auto-update stays on the previous release)");
  process.exit(0);
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`updater-manifest: latest.json written for ${Object.keys(platforms).join(", ")}`);
