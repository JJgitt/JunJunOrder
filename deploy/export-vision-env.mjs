import { writeFile } from "node:fs/promises";

// Export only the explicitly authorized vision settings, never other secrets.
const destination = process.argv[2];
if (!destination || !process.env.VISION_API_KEY) throw new Error("Destination and local vision key are required");
const keys = ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL", "VISION_TIMEOUT_MS"];
const values = Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
await writeFile(destination, JSON.stringify(values), { flag: "wx", mode: 0o600 });
console.log("Vision configuration exported without displaying credentials.");
