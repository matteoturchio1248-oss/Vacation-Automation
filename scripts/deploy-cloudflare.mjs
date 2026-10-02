import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const path = "dist/server/wrangler.json";
const config = JSON.parse(readFileSync(path, "utf8"));
const binding = config.d1_databases?.find((item) => item.binding === "DB");
if (!binding || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.database_id) ||
    binding.database_id === "00000000-0000-4000-8000-000000000000") {
  throw new Error("Create the demo D1 database, set the build variable SFTE_D1_DATABASE_ID, then rebuild before deploying.");
}
if (config.name !== "vacation-automation") throw new Error("Unexpected Worker name; refusing deployment.");
if (process.argv.includes("--check")) {
  console.log("Deployment configuration passed (no deployment performed).");
} else {
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--config", path], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
