import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "src/renderer");

export default defineConfig({
  root,
  base: "./",
  build: {
    emptyOutDir: false,
    outDir: resolve(import.meta.dirname, "dist/renderer")
  }
});
