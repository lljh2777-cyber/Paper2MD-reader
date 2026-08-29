import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const outdir = resolve(root, "dist");

await mkdir(outdir, { recursive: true });
await Promise.all([
  build({
    entryPoints: [resolve(root, "src/extractor.ts")],
    outfile: resolve(outdir, "extractor.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false
  }),
  build({
    entryPoints: [resolve(root, "src/popup.ts")],
    outfile: resolve(outdir, "popup.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false
  }),
  build({
    entryPoints: [resolve(root, "src/precision.ts")],
    outfile: resolve(outdir, "precision.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false
  }),
  build({
    entryPoints: [resolve(root, "src/service-worker.ts")],
    outfile: resolve(outdir, "service-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false
  }),
  build({
    entryPoints: [resolve(root, "src/archive-inspector-worker.ts")],
    outfile: resolve(outdir, "archive-inspector-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false
  }),
  ...["manifest.json", "popup.html", "popup.css", "precision.html", "precision.css"].map((name) => copyFile(resolve(root, name), resolve(outdir, name)))
]);
