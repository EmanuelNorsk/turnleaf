import { scrub } from "../src/util/scrub.js";
const sample = `[12:00:00 INFO]: Steve joined the game
UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5
[12:00:01 INFO]: Steve[/203.0.113.42:51234] logged in
at C:\\Users\\eem50\\Desktop\\server\\plugins\\X.jar
/home/emanuel/server/logs/latest.log`;
console.log(scrub(sample));
process.exit(0);
