import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AFTER_MINERU_ATTRIBUTION_PATH,
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  validateAfterMinerUPackage
} from "../packages/after-mineru-contract/src/index";
import { buildAfterMinerUArchive } from "../packages/repair-core/src/repair-package";

const STATIC_ASSET_LIMIT = 25 * 1024 * 1024;
const FORMAL_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: AFTER_MINERU_PACKAGE_LIMITS.compressedArchiveBytes,
  fileCount: AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: AFTER_MINERU_PACKAGE_LIMITS.totalBytes,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: AFTER_MINERU_PACKAGE_LIMITS.pathDepth
});
const repositoryRoot = process.cwd();
const demoRoot = resolve(repositoryRoot, "sites-reader", "public", "demo", "debyecalculator");

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return Boolean(left && left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]));
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  if (process.argv.slice(2).some((argument) => argument !== "--check")) {
    throw new Error("Usage: npm run demo:formal:build -- [--check]");
  }
  const [archiveBuffer, pdfBuffer, displayRepairBuffer, attributionBuffer] = await Promise.all([
    readFile(resolve(demoRoot, "mineru-original.mineru.zip")),
    readFile(resolve(demoRoot, "source.pdf")),
    readFile(resolve(demoRoot, "display-repair.json")),
    readFile(resolve(demoRoot, "ATTRIBUTION.md"))
  ]);
  const archiveBytes = new Uint8Array(archiveBuffer);
  const sourcePdfBytes = new Uint8Array(pdfBuffer);
  const displayRepairBytes = new Uint8Array(displayRepairBuffer);
  const attributionBytes = new Uint8Array(attributionBuffer);
  const built = await buildAfterMinerUArchive({
    archiveBytes,
    archiveName: "debyecalculator.mineru.zip",
    sourcePdf: { bytes: sourcePdfBytes, name: "source.pdf" },
    displayRepair: { bytes: displayRepairBytes, name: "display-repair.json" },
    attribution: { bytes: attributionBytes }
  });

  if (built.archiveBytes.byteLength >= STATIC_ASSET_LIMIT) {
    throw new Error("Formal demo package exceeds the 25 MiB static asset limit");
  }
  if (
    built.summary.unresolvedTextReplacementCount !== 0
    || new TextDecoder().decode(built.files.get("derived/article.after-mineru.md")!).includes("\uFFFD")
    || built.readerProjection.visuals.some((visual) => visual.caption_text?.includes("\uFFFD"))
  ) throw new Error("Formal demo package still contains a declared display-repair replacement character");
  if (
    !bytesEqual(built.files.get("source/mineru-original.mineru.zip"), archiveBytes)
    || !bytesEqual(built.files.get("source/source.pdf"), sourcePdfBytes)
    || !bytesEqual(built.files.get(AFTER_MINERU_ATTRIBUTION_PATH), attributionBytes)
    || !bytesEqual(built.files.get("_source/ATTRIBUTION.md"), attributionBytes)
  ) throw new Error("Formal demo package did not preserve its immutable source or attribution bytes");

  const extracted = extractValidatedZipEntries(
    built.archiveBytes,
    FORMAL_ARCHIVE_LIMITS,
    isSafeAfterMinerUPath,
    { allowDirectoryEntries: false }
  );
  if (!extracted.has(AFTER_MINERU_MANIFEST_PATH) || extracted.size !== built.files.size) {
    throw new Error("Formal demo package failed its compressed inventory round-trip");
  }
  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(extracted));
  for (const [path, bytes] of built.files) {
    if (!bytesEqual(extracted.get(path), bytes)) {
      throw new Error(`Formal demo package changed a file during ZIP round-trip: ${path}`);
    }
  }

  const archiveSha256 = sha256Bytes(built.archiveBytes);
  const filename = `after-mineru-package-v1-${archiveSha256}.zip`;
  const outputPath = resolve(demoRoot, filename);
  if (resolve(demoRoot, basename(outputPath)) !== outputPath) throw new Error("Unsafe formal demo output path");
  const existing = await readFile(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!bytesEqual(new Uint8Array(existing), built.archiveBytes)) {
      throw new Error(`Refusing to overwrite a mismatched content-addressed asset: ${filename}`);
    }
  } else if (checkOnly) {
    throw new Error(`Formal demo package is missing in --check mode: ${filename}`);
  } else {
    await writeFile(outputPath, built.archiveBytes, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    path: filename,
    size: built.archiveBytes.byteLength,
    sha256: archiveSha256,
    fileCount: built.files.size,
    unresolvedTextReplacementCount: built.summary.unresolvedTextReplacementCount,
    mode: checkOnly ? "check" : "build"
  }, null, 2)}\n`);
}

await main();
