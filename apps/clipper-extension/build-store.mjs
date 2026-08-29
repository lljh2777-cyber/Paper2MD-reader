import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname);
const outdir = resolve(root, "dist-store");
const storeManifest = JSON.parse(await readFile(resolve(root, "manifest.store.json"), "utf8"));
const artifact = resolve(root, `../../output/after-mineru-converter-${storeManifest.version}.zip`);
const checksumArtifact = `${artifact}.sha256`;
const zipMtime = new Date(1980, 0, 1, 0, 0, 0);

const packageFiles = [
  "manifest.json",
  "precision.html",
  "precision.css",
  "precision.js",
  "archive-inspector-worker.js",
  "store-service-worker.js",
  "THIRD_PARTY_NOTICES.txt",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "_locales/zh_CN/messages.json"
];

await Promise.all([
  mkdir(outdir, { recursive: true }),
  mkdir(resolve(outdir, "icons"), { recursive: true }),
  mkdir(resolve(outdir, "_locales/zh_CN"), { recursive: true }),
  mkdir(dirname(artifact), { recursive: true })
]);

await Promise.all([
  build({
    entryPoints: [resolve(root, "src/precision.ts")],
    outfile: resolve(outdir, "precision.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false,
    legalComments: "none"
  }),
  build({
    entryPoints: [resolve(root, "src/store-service-worker.ts")],
    outfile: resolve(outdir, "store-service-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false,
    legalComments: "none"
  }),
  build({
    entryPoints: [resolve(root, "src/archive-inspector-worker.ts")],
    outfile: resolve(outdir, "archive-inspector-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false,
    legalComments: "none"
  }),
  copyFile(resolve(root, "manifest.store.json"), resolve(outdir, "manifest.json")),
  copyFile(resolve(root, "precision.html"), resolve(outdir, "precision.html")),
  copyFile(resolve(root, "precision.css"), resolve(outdir, "precision.css")),
  copyFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), resolve(outdir, "THIRD_PARTY_NOTICES.txt")),
  copyFile(resolve(root, "store-assets/icon-16.png"), resolve(outdir, "icons/icon-16.png")),
  copyFile(resolve(root, "store-assets/icon-32.png"), resolve(outdir, "icons/icon-32.png")),
  copyFile(resolve(root, "store-assets/icon-48.png"), resolve(outdir, "icons/icon-48.png")),
  copyFile(resolve(root, "store-assets/icon-128.png"), resolve(outdir, "icons/icon-128.png")),
  copyFile(resolve(root, "_locales/zh_CN/messages.json"), resolve(outdir, "_locales/zh_CN/messages.json"))
]);

const entries = Object.fromEntries(await Promise.all(packageFiles.map(async (path) => [
  path,
  new Uint8Array(await readFile(resolve(outdir, path)))
])));
const archive = zipSync(entries, { level: 9, mtime: zipMtime });
await writeFile(artifact, archive);

const sha256 = createHash("sha256").update(archive).digest("hex");
await writeFile(checksumArtifact, `${sha256}  ${basename(artifact)}\n`, "utf8");
console.log(`Built ${artifact}`);
console.log(`SHA-256 ${sha256}`);
console.log(`Checksum ${checksumArtifact}`);
