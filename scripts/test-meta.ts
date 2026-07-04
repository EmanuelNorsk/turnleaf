// Quick harness: jarMetas speed + depend parsing across the tests library.
import fs from "node:fs";
import path from "node:path";
import { jarMetas, shutdownEngine } from "../src/engine/client.js";
import { parsePluginMeta } from "../src/scan/scanner.js";

const dir = process.argv[2] ?? "tests";
const jars = fs.readdirSync(dir).filter((f) => f.endsWith(".jar")).map((f) => path.join(dir, f));
const t0 = Date.now();
const metas = await jarMetas(jars);
console.log(`${metas.length} jars in ${Date.now() - t0}ms`);
for (const m of metas) {
  const meta = parsePluginMeta(m.pluginYml);
  const dep = meta?.depend?.length ? ` depend=[${meta.depend}]` : "";
  const soft = meta?.softDepend?.length ? ` soft=[${meta.softDepend.slice(0, 4)}…]` : "";
  console.log(`  ${path.basename(m.jar).padEnd(45)} ${meta?.name ?? "(not a plugin)"}${dep}${soft}`);
}
shutdownEngine();
