import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
await build({
  entryPoints: [resolve(root, "src/server.ts")],
  outfile: resolve(root, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false
});
