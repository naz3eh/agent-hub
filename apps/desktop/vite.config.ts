import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  esbuild: { jsx: "automatic" },
  root: "src/renderer",
  build: {
    outDir: resolve(fileURLToPath(new URL(".", import.meta.url)), "dist/renderer"),
    emptyOutDir: true,
  },
});
