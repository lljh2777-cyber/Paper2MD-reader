import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    emptyOutDir: true,
    outDir: "dist-local",
    rollupOptions: {
      input: resolve(import.meta.dirname, "local-reader/index.html")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true
  }
});
