import fs from "node:fs";
import { parseIncidents } from "../src/ai/repair.js";
const SERVER_PKGS = ["net/minecraft","org/bukkit","io/papermc","com/mojang","co/aikar","com/destroystokyo","java/","jdk/","sun/","io/netty","com/google","org/spigotmc"];
const log = fs.readFileSync(process.argv[2], "utf8");
const incidents = parseIncidents(log, (cls, jar) => jar !== null && !SERVER_PKGS.some((p) => cls.startsWith(p)));
console.log(incidents.length, "incidents");
for (const i of incidents) console.log("-", i.jars.join(","), "|", i.header.slice(0, 80));
process.exit(0);
