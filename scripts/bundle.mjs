// Bundle the whole CLI (all TS sources + npm deps) into one plain-Node file.
// Output: dist/folia.cjs — runnable by `node dist/folia.cjs <command>` with no
// tsx, no node_modules, no TypeScript at runtime. This is what the packaged
// desktop app ships and spawns; only Node + Java remain runtime prerequisites.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const repoRaw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
const repo = repoRaw.match(/github(?:\.com)?[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? "";

await esbuild.build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(root, "dist", "folia.cjs"),
  // Keep native/optional deps out of the bundle; none are required for our
  // code paths, and pulling them in only produces resolver noise.
  external: ["fsevents"],
  logLevel: "info",
  legalComments: "none",
  // CJS has no import.meta, so map `import.meta.url` to a __filename-based file
  // URL declared in the banner. This keeps src/env.ts's dev fallback (FOD_HOME
  // unset) resolving the app root from the bundle's own location.
  define: {
    "import.meta.url": "__fodBundleUrl",
    // The packaged app has no package.json, so bake version + repo slug in
    // (used by the GUI's update check against GitHub Releases).
    __FOD_PKG_VERSION__: JSON.stringify(pkg.version),
    __FOD_PKG_REPO__: JSON.stringify(repo),
  },
  banner: {
    js: "const __fodBundleUrl = require('url').pathToFileURL(__filename).href;",
  },
});
