import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname);

export default defineConfig({
  root,
  build: {
    emptyOutDir: true,
    outDir: resolve(root, "../../dist-web")
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true
  }
});
