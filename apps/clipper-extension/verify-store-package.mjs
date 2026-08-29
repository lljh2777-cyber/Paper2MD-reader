import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { unzipSync } from "fflate";

const root = resolve(import.meta.dirname);
const sourceManifest = JSON.parse(await readFile(resolve(root, "manifest.store.json"), "utf8"));
const artifact = resolve(root, `../../output/after-mineru-converter-${sourceManifest.version}.zip`);
const checksumArtifact = `${artifact}.sha256`;
const expectedFiles = [
  "_locales/zh_CN/messages.json",
  "archive-inspector-worker.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "precision.css",
  "precision.html",
  "precision.js",
  "store-service-worker.js",
  "THIRD_PARTY_NOTICES.txt"
].sort();
const expectedOrigins = [
  "https://mineru.net/*",
  "https://mineru.oss-cn-shanghai.aliyuncs.com/*",
  "https://cdn-mineru.openxlab.org.cn/*"
];
const expectedExtensionCsp = `default-src 'none'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src ${expectedOrigins.map((origin) => origin.slice(0, -2)).join(" ")}; img-src 'self' data: blob:; style-src 'self'; worker-src 'self'`;

function fail(message) {
  throw new Error(`Store package verification failed: ${message}`);
}

function text(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) fail("invalid PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function centralDirectoryPaths(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdSignature = 0x06054b50;
  const centralHeaderSignature = 0x02014b50;
  if (bytes.byteLength < 22) fail("ZIP end-of-central-directory record is missing");

  const minimumEocdOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (view.getUint32(offset, true) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) fail("ZIP end-of-central-directory record is missing");

  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) fail("ZIP end-of-central-directory record is malformed");
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDiskNumber = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntries !== totalEntries) fail("multi-disk ZIP archives are not allowed");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP64 archives are not allowed");
  if (centralOffset + centralSize !== eocdOffset) fail("ZIP central directory bounds are invalid");

  const paths = [];
  const seenRawNames = new Set();
  const seenPaths = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== centralHeaderSignature) {
      fail("ZIP central directory entry is malformed");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const recordEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (!nameLength || recordEnd > eocdOffset) fail("ZIP central directory entry is malformed");

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawNameKey = Buffer.from(rawName).toString("hex");
    if (seenRawNames.has(rawNameKey)) fail("duplicate raw ZIP central-directory entry");
    seenRawNames.add(rawNameKey);
    let path = "";
    for (const value of rawName) {
      if (value > 0x7f) fail("non-ASCII ZIP entry name is not allowed in the Store package");
      path += String.fromCharCode(value);
    }
    if (seenPaths.has(path)) fail(`duplicate ZIP central-directory path: ${path}`);
    seenPaths.add(path);
    paths.push(path);
    offset = recordEnd;
  }
  if (offset !== eocdOffset) fail("ZIP central directory size does not match its entries");
  return paths;
}

const archive = new Uint8Array(await readFile(artifact));
if (archive.byteLength > 5 * 1024 * 1024) fail("archive exceeds the 5 MiB review budget");
const centralPaths = centralDirectoryPaths(archive);
const files = unzipSync(archive);
const paths = centralPaths.toSorted();
if (JSON.stringify(paths) !== JSON.stringify(expectedFiles)) fail(`unexpected archive entries: ${paths.join(", ")}`);
if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(paths)) fail("ZIP parser and central directory disagree on package entries");

const manifest = JSON.parse(text(files["manifest.json"]));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (manifest.version !== sourceManifest.version) fail("manifest version and artifact version differ");
if (Object.hasOwn(manifest, "key")) fail("store manifest must not pin an unpacked-extension key");
if (Object.hasOwn(manifest, "permissions")) fail("store build must not request required permissions");
if (Object.hasOwn(manifest, "host_permissions")) fail("store build must not request persistent host permissions");
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOrigins)) fail("optional hosts are broader than the approved MinerU transfer origins");
if (manifest.background?.service_worker !== "store-service-worker.js") fail("store background must use the bounded service worker");
if (manifest.action?.default_popup) fail("toolbar action must not keep the long-running conversion in a popup");
if (sourceManifest.content_security_policy?.extension_pages !== expectedExtensionCsp) fail("source manifest CSP differs from the approved Store policy");
if (manifest.content_security_policy?.extension_pages !== expectedExtensionCsp) fail("packaged manifest CSP differs from the approved Store policy");

for (const size of [16, 32, 48, 128]) {
  const dimensions = pngDimensions(files[`icons/icon-${size}.png`]);
  if (dimensions.width !== size || dimensions.height !== size) fail(`icon-${size}.png has incorrect dimensions`);
}

const precisionHtml = text(files["precision.html"]);
if (!precisionHtml.includes('<script type="module" src="precision.js"></script>')) fail("precision page script is missing");
if (/<script\b[^>]*\bsrc=["']https?:/iu.test(precisionHtml) || /<script\b(?![^>]*\bsrc=)[^>]*>/iu.test(precisionHtml)) {
  fail("remote or inline executable script found");
}

const executable = `${text(files["precision.js"])}\n${text(files["archive-inspector-worker.js"])}\n${text(files["store-service-worker.js"])}`;
for (const forbidden of ["eval(", "new Function", "WebAssembly.compile", "WebAssembly.instantiateStreaming", "localStorage", "indexedDB", "chrome.storage", "document.cookie"]) {
  if (executable.includes(forbidden)) fail(`forbidden executable capability found: ${forbidden}`);
}

if (!text(files["THIRD_PARTY_NOTICES.txt"]).includes("Permission is hereby granted")) {
  fail("fflate MIT notice is missing or incomplete");
}

const digest = createHash("sha256").update(archive).digest("hex");
const expectedChecksum = `${digest}  ${basename(artifact)}\n`;
if (await readFile(checksumArtifact, "utf8") !== expectedChecksum) fail("SHA-256 sidecar does not match the Store package");
console.log(`Verified ${artifact}`);
console.log(`Files ${paths.length}; bytes ${archive.byteLength}; SHA-256 ${digest}`);
