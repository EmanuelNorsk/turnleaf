// Quick harness: does parseIncidents find the real WolfyUtilities crash?
import fs from "node:fs";
import { parseIncidents } from "../src/ai/repair.js";
import { indexJar } from "../src/engine/client.js";

const [logFile, jar] = process.argv.slice(2);
const index = await indexJar(jar);
const classes = new Set(index.classes.map((c) => c.name.split("$")[0]));
const incidents = parseIncidents(fs.readFileSync(logFile, "utf8"), (cls) => classes.has(cls));
console.log(`${incidents.length} incident(s):`);
for (const inc of incidents) {
  console.log(`- ${inc.header.slice(0, 110)}`);
  console.log(`  classes: ${inc.classes.join(", ")}   jars: ${inc.jars.join(", ")}`);
}
process.exit(0);
