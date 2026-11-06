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
                // Every Env key is fixed here so a developer's .dev.vars cannot steer tests onto another path (or a real API).
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  PUBLIC_ORIGIN: "http://127.0.0.1:5173",
                  DEV_SKIP_CLAUDE: "1",
                  SESSION_SECRET: "test-session-secret",
                  ANTHROPIC_API_KEY: "",
                  SPOTIFY_CLIENT_ID: "",
                  GOOGLE_OAUTH_CLIENT_ID: "",
                  GOOGLE_OAUTH_CLIENT_SECRET: "",
                  GOOGLE_TTS_SA_JSON: "",
                  TMDB_API_KEY: "",
                  YOUTUBE_API_KEY: "",
                  GOOGLE_BOOKS_API_KEY: "",
                  ADMIN_TOKEN: "",
                  EPISODE_DAILY_LIMIT: "",
                  EPISODE_GLOBAL_DAILY_LIMIT: "",
                  CLOUD_TTS_GLOBAL_DAILY_LIMIT: "",
                  UNIT_DAILY_LIMIT: "",
                  RATE_LIMIT_PER_MINUTE: "",
                  CLAUDE_MODEL: "",
                  GEMINI_TTS_MODEL: "",
                  GEMINI_TTS_VOICE: "",
                },
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
