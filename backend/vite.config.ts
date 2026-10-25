import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  server: {
    fs: {
      // The Worker imports the shared simulation from ../game, outside this package.
      allow: [".."],
    },
  },
});
