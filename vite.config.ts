import vinext from "vinext";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sites } from "./build/sites-vite-plugin";

// macOS sandbox previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        configPath: "./wrangler.jsonc",
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: (config) => {
          const db = config.d1_databases?.find((binding) => binding.binding === "DB");
          if (!db) throw new Error("Cloudflare deployment requires the DB binding.");
          if (process.env.SFTE_D1_DATABASE_ID) db.database_id = process.env.SFTE_D1_DATABASE_ID;
          // The generated deployment config lives under dist/server. Keep CLI
          // migrations anchored to the checked-in directory, not that output.
          db.migrations_dir = resolve(process.cwd(), "drizzle");
        },
      }),
    ],
  };
});
