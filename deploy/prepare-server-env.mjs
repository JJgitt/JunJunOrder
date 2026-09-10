import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Run with --env-file=.env.local; never logs credentials or overwrites a file.
const [destination, origin] = process.argv.slice(2);
if (!destination || !origin) throw new Error("Provide destination and site origin");
const site = new URL(origin);
const values = {
  APP_DOMAIN: site.protocol === "https:" ? site.hostname : ":80",
  SITE_ORIGIN: site.origin,
  POSTGRES_DB: "junjun_order",
  POSTGRES_USER: "junjun",
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  AUTH_SECRET: randomBytes(48).toString("hex"),
  COOKIE_SECURE: String(site.protocol === "https:"),
  DATABASE_POOL_SIZE: "5",
  ADMIN_WECHAT_ID: "bootstrap-admin",
  ADMIN_PASSWORD: randomBytes(24).toString("hex"),
};
for (const key of ["VISION_API_BASE","VISION_API_KEY","VISION_MODEL","VISION_TIMEOUT_MS","OCR_ENDPOINT","OCR_TOKEN","DEWU_SYNC_ENDPOINT","DEWU_APP_KEY","DEWU_APP_SECRET"]) {
  if (process.argv.includes("--include-service-secrets") && process.env[key]) values[key] = process.env[key];
}
const quote = value => {
  if (/[\r\n']/.test(value)) throw new Error("Unsupported environment value");
  return "'" + value + "'";
};
await writeFile(destination, Object.entries(values).map(([key,value]) => key + "=" + quote(value)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
console.log("Server environment prepared; credentials not displayed.");
