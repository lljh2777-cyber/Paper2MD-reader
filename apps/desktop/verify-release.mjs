import { listPackage } from "@electron/asar";
import { spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname);
const distRoot = resolve(desktopRoot, "dist");
const outputRoot = process.env.PAPER2MD_DESKTOP_OUTPUT
  ? resolve(process.env.PAPER2MD_DESKTOP_OUTPUT)
  : resolve(desktopRoot, "out");

async function requireNonEmpty(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) throw new Error(`${label} is missing or empty: ${path}`);
}

async function verifyPackagedRuntime() {
  const executable = resolve(outputRoot, "win-unpacked/Paper2MD Reader.exe");
  await requireNonEmpty(executable, "unpacked desktop executable");
  const profile = resolve(outputRoot, "runtime-smoke-profile");
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["--paper2md-packaging-smoke", `--user-data-dir=${profile}`], {
      stdio: "ignore",
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Packaged desktop runtime smoke check timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Packaged desktop runtime smoke check exited with ${code}`));
    });
  });
}

async function verifyBuild() {
  const required = [
    "main.cjs",
    "preload.cjs",
    "reader-contract-worker.cjs",
    "renderer/index.html",
    "renderer/assets/index.js",
    "renderer/assets/index.css"
  ];
  await Promise.all(required.map((path) => requireNonEmpty(resolve(distRoot, path), path)));

  const html = await readFile(resolve(distRoot, "renderer/index.html"), "utf8");
  if (!html.includes('./assets/index.js') || !html.includes('./assets/index.css')) {
    throw new Error("Desktop renderer entry does not reference deterministic release assets");
  }
  if (/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)/.test(html)) {
    throw new Error("Desktop renderer entry still references historical hashed assets");
  }

  const renderer = await readFile(resolve(distRoot, "renderer/assets/index.js"), "utf8");
  if (renderer.includes("pdf.worker.min.mjs")) throw new Error("Desktop renderer still depends on an external PDF.js worker");
  if (/new URL\([`"]pdf\.js[`"],\s*import\.meta\.url\)/.test(renderer)) {
    throw new Error("Desktop renderer still loads PDF.js from a runtime-only dynamic chunk");
  }

  const fonts = (await readdir(resolve(distRoot, "renderer/assets"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:woff2?|ttf)$/.test(entry.name));
  if (fonts.length < 3) throw new Error("Desktop renderer release is missing KaTeX fonts");
}

async function verifyPackage() {
  await verifyBuild();
  const asarPath = resolve(outputRoot, "win-unpacked/resources/app.asar");
  await requireNonEmpty(asarPath, "packaged ASAR");
  const entries = listPackage(asarPath).map((path) => path.replaceAll("\\", "/"));
  const required = [
    "/package.json",
    "/dist/main.cjs",
    "/dist/preload.cjs",
    "/dist/renderer/index.html",
    "/dist/renderer/assets/index.js",
    "/dist/renderer/assets/index.css"
  ];
  for (const path of required) {
    if (!entries.includes(path)) throw new Error(`Packaged desktop app is missing ${path}`);
  }
  if (entries.some((path) => path.endsWith(".py") || path.includes("/processing-scripts/") || path.includes("/src/"))) {
    throw new Error("Packaged desktop app contains a retired Python script or source tree");
  }
  await requireNonEmpty(
    resolve(outputRoot, "win-unpacked/resources/app.asar.unpacked/dist/reader-contract-worker.cjs"),
    "unpacked reader contract worker"
  );
  await verifyPackagedRuntime();
}

async function verifyArtifacts() {
  await verifyPackage();
  const packageJson = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  await Promise.all([
    requireNonEmpty(resolve(outputRoot, `Paper2MD-Reader-Setup-${version}-x64.exe`), "unsigned NSIS installer"),
    requireNonEmpty(resolve(outputRoot, `Paper2MD-Reader-Portable-${version}-x64.exe`), "unsigned portable executable")
  ]);
}

const mode = process.argv[2] ?? "build";
if (mode === "build") await verifyBuild();
else if (mode === "package") await verifyPackage();
else if (mode === "artifacts") await verifyArtifacts();
else throw new Error(`Unknown verification mode: ${mode}`);

await access(distRoot);
console.log(`Desktop ${mode} verification passed.`);
