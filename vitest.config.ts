import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations, SESSION_SECRET: "test-session-secret", ANTHROPIC_API_KEY: "" },
                assets: { directory: path.join(import.meta.dirname, "public"), binding: "ASSETS" },
              },
            }),
          ],
          test: {
            name: "worker",
            setupFiles: ["./test/apply-migrations.ts"],
            include: ["test/worker/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "scripts",
            environment: "node",
            include: ["test/scripts/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "client",
            environment: "happy-dom",
            include: ["test/client/**/*.test.ts"],
          },
        },
      ],
    },
  };
});
