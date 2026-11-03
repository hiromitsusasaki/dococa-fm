import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "worker" } })],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: { player: "src/client/player.tsx" },
          output: { entryFileNames: "assets/[name].js" },
        },
      },
    },
  },
});
