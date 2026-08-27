import { build as esbuild } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";

const root = resolve(import.meta.dirname);
const processingScripts = resolve(root, "dist", "processing-scripts");
await mkdir(processingScripts, { recursive: true });
await Promise.all([
  "build_reader_contracts.py",
  "mineru_viewer_contract.py",
  "mineru_visual_adjudication.py"
].map((name) => copyFile(
  resolve(root, "..", "processing-service", "scripts", name),
  resolve(processingScripts, name)
)));
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
