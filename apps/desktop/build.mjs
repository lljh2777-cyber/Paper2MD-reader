import { build as esbuild } from "esbuild";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";

const root = resolve(import.meta.dirname);
await Promise.all([
  esbuild({
    entryPoints: [resolve(root, "src/main/main.ts")],
    outfile: resolve(root, "dist/main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false
  }),
  esbuild({
    entryPoints: [resolve(root, "src/preload/preload.ts")],
    outfile: resolve(root, "dist/preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false
  })
]);
await viteBuild({ configFile: resolve(root, "vite.config.mjs") });
