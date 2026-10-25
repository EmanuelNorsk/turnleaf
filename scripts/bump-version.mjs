// Set the app version everywhere it lives: package.json, package-lock.json,
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock.
//
//   node scripts/bump-version.mjs patch|minor|major|<x.y.z>
//
// Prints the new version (CI uses it for the tag).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (rel) => path.join(root, rel);
const arg = process.argv[2];

const pkg = JSON.parse(fs.readFileSync(file("package.json"), "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  arg === "major" ? `${major + 1}.0.0`
  : arg === "minor" ? `${major}.${minor + 1}.0`
  : arg === "patch" ? `${major}.${minor}.${patch + 1}`
  : /^\d+\.\d+\.\d+$/.test(arg ?? "") ? arg
  : null;
if (!next) {
  console.error("usage: bump-version.mjs patch|minor|major|<x.y.z>");
  process.exit(1);
}

// Edit in place (not parse + stringify) so formatting never churns.
const editText = (rel, pattern, replacement) => {
  const text = fs.readFileSync(file(rel), "utf8");
  if (!pattern.test(text)) throw new Error(`version not found in ${rel}`);
  fs.writeFileSync(file(rel), text.replace(pattern, replacement));
};

// The app's own version is the first "version" key in each JSON file.
const jsonVersion = /("version":\s*)"[^"]+"/;
editText("package.json", jsonVersion, `$1"${next}"`);
// package-lock: the top-level field, then packages[""] (the second occurrence).
editText("package-lock.json", jsonVersion, `$1"${next}"`);
editText("package-lock.json", /("packages":\s*\{\s*"":\s*\{[^}]*?"version":\s*)"[^"]+"/, `$1"${next}"`);
editText(path.join("src-tauri", "tauri.conf.json"), jsonVersion, `$1"${next}"`);
editText(path.join("src-tauri", "Cargo.toml"), /^version = "[^"]+"/m, `version = "${next}"`);
editText(path.join("src-tauri", "Cargo.lock"), /(name = "turnleaf"\r?\nversion = )"[^"]+"/, `$1"${next}"`);

console.log(next);
