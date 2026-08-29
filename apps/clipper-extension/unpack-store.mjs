import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";

const root = resolve(import.meta.dirname);
const manifest = JSON.parse(await readFile(resolve(root, "manifest.store.json"), "utf8"));
const artifact = resolve(root, `../../output/after-mineru-converter-${manifest.version}.zip`);
const archive = new Uint8Array(await readFile(artifact));
const digest = createHash("sha256").update(archive).digest("hex");
const target = resolve(root, `../../output/chrome-unpacked/after-mineru-converter-${manifest.version}-${digest.slice(0, 8)}`);
const files = unzipSync(archive);

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await listFiles(resolve(directory, entry.name), relative));
    else if (entry.isFile()) paths.push(relative);
    else throw new Error(`Unexpected unpacked Store entry type: ${relative}`);
  }
  return paths;
}

let exists = false;
try { exists = (await stat(target)).isDirectory(); }
catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (!exists) {
  await mkdir(target, { recursive: true });
  for (const [path, bytes] of Object.entries(files)) {
    const output = resolve(target, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
} else {
  const existingPaths = (await listFiles(target)).sort();
  const expectedPaths = Object.keys(files).sort();
  if (JSON.stringify(existingPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Existing unpacked directory differs from the verified ZIP: ${target}`);
  }
  for (const [path, bytes] of Object.entries(files)) {
    const existing = new Uint8Array(await readFile(resolve(target, path)));
    if (!existing.every((value, index) => value === bytes[index]) || existing.byteLength !== bytes.byteLength) {
      throw new Error(`Existing unpacked file differs from the verified ZIP: ${path}`);
    }
  }
}

console.log(`Chrome unpacked directory ${target}`);
console.log(`Source SHA-256 ${digest}`);
