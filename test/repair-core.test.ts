import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, type Zippable } from "fflate";
import {
  AFTER_MINERU_PACKAGE_LIMITS,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  validateAfterMinerUPackage
} from "../packages/after-mineru-contract/src/index";
import {
  repairMinerUArchive,
  zipAfterMinerUPackage
} from "../packages/repair-core/src/index";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import {
  extractAfterMinerUArchiveBytes,
  importAfterMinerUArchiveBytes,
  importAfterMinerUArchiveFile
} from "../apps/web/src/after-mineru-archive-import";
import { PackageLoader } from "../src/model/package-loader";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

const rawArchivePath = resolve(
  "sites-reader",
  "public",
  "demo",
  "debyecalculator",
  "mineru-original.mineru.zip"
);

function uncheckedZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries = Object.create(null) as Zippable;
  for (const [path, bytes] of files) entries[path] = bytes;
  return zipSync(entries, { level: 1 });
}

describe("After-MinerU repair-core", () => {
  it("materializes and verifies one deterministic package from a real MinerU ZIP", async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    const raw = extractMinerUArchiveForReader(sourceArchive);
    const first = await repairMinerUArchive({
      archiveBytes: sourceArchive,
      archiveName: "debyecalculator.mineru.zip"
    });
    const mutableSecondInput = sourceArchive.slice();
    const secondPromise = repairMinerUArchive({
      archiveBytes: mutableSecondInput,
      archiveName: "debyecalculator.mineru.zip"
    });
    mutableSecondInput.fill(0);
    const second = await secondPromise;
    const firstZip = await zipAfterMinerUPackage(first.files);
    const secondZip = await zipAfterMinerUPackage(second.files);
    const webImportedFiles = await extractAfterMinerUArchiveBytes(firstZip);
    const firstZipBuffer = firstZip.buffer.slice(
      firstZip.byteOffset,
      firstZip.byteOffset + firstZip.byteLength
    ) as ArrayBuffer;
    const previewFileSystem = await importAfterMinerUArchiveFile(new File([
      firstZipBuffer
    ], "debyecalculator.after-mineru.zip", { type: "application/zip" }), {
      expectedFileCount: first.files.size
    });
    const previewLoaded = await new PackageLoader(previewFileSystem).loadDetected();

    expect(sha256Bytes(firstZip)).toBe(sha256Bytes(secondZip));
    expect(firstZip).toEqual(secondZip);
    const zipView = new DataView(firstZip.buffer, firstZip.byteOffset, firstZip.byteLength);
    let centralOffset = -1;
    for (let offset = 0; offset <= firstZip.byteLength - 4; offset += 1) {
      if (zipView.getUint32(offset, true) === 0x02014b50) {
        centralOffset = offset;
        break;
      }
    }
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    expect(zipView.getUint16(centralOffset + 12, true)).toBe(0);
    expect(zipView.getUint16(centralOffset + 14, true)).toBe(33);
    expect(webImportedFiles.size).toBe(first.files.size);
    expect(previewLoaded.packageIntegrity).toBe("verified");
    expect(previewLoaded.activeProjection?.kind).toBe("verified-derived");
    expect(previewLoaded.visualReview).toBeUndefined();
    expect(previewLoaded.textRecovery).toBeUndefined();
    previewFileSystem.dispose();
    await expect(importAfterMinerUArchiveBytes(firstZipBuffer, "debyecalculator.after-mineru.zip", {
      expectedFileCount: first.files.size - 1
    })).rejects.toThrow(/handoff declared/);
    expect(new Uint8Array(await webImportedFiles.get("source/mineru-original.mineru.zip")!.arrayBuffer()))
      .toEqual(sourceArchive);
    expect(first.files.get("source/mineru-original.mineru.zip")).toEqual(sourceArchive);
    expect(first.files.get(`source/${raw.articlePath}`)).toEqual(raw.files.get(raw.articlePath));
    expect(first.files.get("article.md")).toEqual(raw.files.get(raw.articlePath));
    expect(first.files.get("derived/article.after-mineru.md")).toBeDefined();
    expect(first.manifest.schema_version).toBe("after-mineru-package-v1");
    expect(first.manifest.source.article_path).toBe(`source/${raw.articlePath}`);
    expect(first.readerProjection.visuals.length).toBeGreaterThan(0);
    expect(first.summary.repairedVisualCount).toBeGreaterThan(0);
    expect(first.validation.status).toBe("passed");

    const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(first.files));
    expect(verified.readerProjection).toEqual(first.readerProjection);
    expect(verified.provenance.source_archive.sha256).toBe(first.validation.source_archive_sha256);
    expect(verified.provenance.derived_article.sha256).toBe(first.manifest.derived.files[0]?.sha256);
    expect(verified.provenance.source_tree.root_prefix).toBe(raw.rootPrefix);
    expect(verified.provenance.source_tree.entries).toHaveLength(raw.files.size);
    expect(verified.provenance.source_tree.entries).toContainEqual(expect.objectContaining({
      archive_path: `${raw.rootPrefix}${raw.articlePath}`,
      package_path: `source/${raw.articlePath}`,
      sha256: sha256Bytes(raw.files.get(raw.articlePath)!)
    }));

    const extraEmpty = new Map(first.files);
    extraEmpty.set("extra-empty.txt", new Uint8Array());
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(extraEmpty)))
      .rejects.toThrow("unmanifested file");
    await expect(zipAfterMinerUPackage(extraEmpty)).rejects.toThrow("unmanifested file");
    await expect(extractAfterMinerUArchiveBytes(uncheckedZip(extraEmpty))).rejects.toThrow();

    const extraDeepSource = new Map(first.files);
    extraDeepSource.set("source/deep/unlisted.txt", new TextEncoder().encode("not in manifest"));
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(extraDeepSource)))
      .rejects.toThrow("unmanifested file");
    await expect(zipAfterMinerUPackage(extraDeepSource)).rejects.toThrow("unmanifested file");
    await expect(extractAfterMinerUArchiveBytes(uncheckedZip(extraDeepSource)))
      .rejects.toThrow("unmanifested file");

    const extraDirectory = new Map(first.files);
    extraDirectory.set("source/deep/", new Uint8Array());
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(extraDirectory)))
      .rejects.toThrow("unsafe or conflicting path");
    await expect(extractAfterMinerUArchiveBytes(uncheckedZip(extraDirectory)))
      .rejects.toThrow("unmanifested directory entry");

    const zeroBoundFile = new Map(first.files);
    const zeroManifest = structuredClone(first.manifest);
    zeroBoundFile.set(zeroManifest.derived.article_path, new Uint8Array());
    const zeroRecord = zeroManifest.derived.files.find((entry) => entry.path === zeroManifest.derived.article_path)!;
    zeroRecord.size = 0;
    zeroRecord.sha256 = sha256Bytes(new Uint8Array());
    zeroBoundFile.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(zeroManifest, null, 2)}\n`)
    );
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(zeroBoundFile)))
      .rejects.toThrow("manifest.derived.files");

    const forgedSourceTree = new Map(first.files);
    const forgedManifest = structuredClone(first.manifest);
    const forgedProvenance = structuredClone(verified.provenance);
    const forgedBinding = forgedProvenance.source_tree.entries.find((entry) => (
      entry.package_path !== forgedManifest.source.article_path
      && entry.package_path !== forgedManifest.source.content_list_path
      && entry.package_path !== forgedManifest.source.pdf_path
    ))!;
    const forgedBytes = forgedSourceTree.get(forgedBinding.package_path)!.slice();
    forgedBytes[0] = forgedBytes[0]! ^ 1;
    const forgedHash = sha256Bytes(forgedBytes);
    forgedSourceTree.set(forgedBinding.package_path, forgedBytes);
    const forgedSourceRecord = forgedManifest.source.files.find((entry) => entry.path === forgedBinding.package_path)!;
    forgedSourceRecord.sha256 = forgedHash;
    forgedBinding.sha256 = forgedHash;
    for (const alias of forgedManifest.compatibility.aliases.filter((entry) => entry.canonical_path === forgedBinding.package_path)) {
      alias.sha256 = forgedHash;
      forgedSourceTree.set(alias.path, forgedBytes);
    }
    const forgedProvenanceBytes = new TextEncoder().encode(`${JSON.stringify(forgedProvenance, null, 2)}\n`);
    forgedSourceTree.set(forgedManifest.sidecars.provenance_path, forgedProvenanceBytes);
    const forgedProvenanceRecord = forgedManifest.sidecars.files
      .find((entry) => entry.path === forgedManifest.sidecars.provenance_path)!;
    forgedProvenanceRecord.size = forgedProvenanceBytes.byteLength;
    forgedProvenanceRecord.sha256 = sha256Bytes(forgedProvenanceBytes);
    forgedSourceTree.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(forgedManifest, null, 2)}\n`)
    );
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(forgedSourceTree)))
      .rejects.toThrow("source archive entry does not match provenance");

    if (verified.provenance.source_pdf_origin === "archive-entry") {
      const forgedPdfOrigin = new Map(first.files);
      const originManifest = structuredClone(first.manifest);
      const originProvenance = structuredClone(verified.provenance);
      originProvenance.source_pdf_origin = "explicit-selection";
      const originBytes = new TextEncoder().encode(`${JSON.stringify(originProvenance, null, 2)}\n`);
      forgedPdfOrigin.set(originManifest.sidecars.provenance_path, originBytes);
      const originRecord = originManifest.sidecars.files
        .find((entry) => entry.path === originManifest.sidecars.provenance_path)!;
      originRecord.size = originBytes.byteLength;
      originRecord.sha256 = sha256Bytes(originBytes);
      forgedPdfOrigin.set(
        "after-mineru.manifest.json",
        new TextEncoder().encode(`${JSON.stringify(originManifest, null, 2)}\n`)
      );
      await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(forgedPdfOrigin)))
        .rejects.toThrow("source PDF origin is inconsistent");
    }

    const missingProvenance = new Map(first.files);
    missingProvenance.delete(first.manifest.sidecars.provenance_path);
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(missingProvenance)))
      .rejects.toThrow("provenance");

    const missingCompatibilityAlias = new Map(first.files);
    const aliasManifest = structuredClone(first.manifest);
    aliasManifest.compatibility.aliases = aliasManifest.compatibility.aliases
      .filter((entry) => entry.path !== "article.md");
    missingCompatibilityAlias.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(aliasManifest, null, 2)}\n`)
    );
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(missingCompatibilityAlias)))
      .rejects.toThrow("compatibility alias");

    const invalidPdfCrop = new Map(first.files);
    const cropProjection = structuredClone(first.readerProjection);
    cropProjection.visuals[0]!.display = {
      mode: "pdf-crop",
      pdf_path: first.manifest.source.article_path,
      bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      padding: 0
    };
    const cropBytes = new TextEncoder().encode(`${JSON.stringify(cropProjection, null, 2)}\n`);
    invalidPdfCrop.set(first.manifest.sidecars.reader_projection_path, cropBytes);
    const cropManifest = structuredClone(first.manifest);
    const cropRecord = cropManifest.sidecars.files.find((entry) => entry.path === cropManifest.sidecars.reader_projection_path)!;
    cropRecord.size = cropBytes.byteLength;
    cropRecord.sha256 = sha256Bytes(cropBytes);
    invalidPdfCrop.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(cropManifest, null, 2)}\n`)
    );
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(invalidPdfCrop)))
      .rejects.toThrow("source PDF");

    const oversizedRole = new Map(first.files);
    const oversizedManifest = structuredClone(first.manifest);
    oversizedManifest.derived.files[0]!.size = AFTER_MINERU_PACKAGE_LIMITS.articleBytes + 1;
    oversizedRole.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(oversizedManifest, null, 2)}\n`)
    );
    const oversizedReads: string[] = [];
    await expect(validateAfterMinerUPackage({
      async exists(path) { return oversizedRole.has(path); },
      async fileInfo(path) {
        const value = oversizedRole.get(path);
        return value ? { size: value.byteLength } : undefined;
      },
      async readBinary(path) {
        oversizedReads.push(path);
        return oversizedRole.get(path)!;
      }
    })).rejects.toThrow("derived article");
    expect(oversizedReads).toEqual(["after-mineru.manifest.json"]);

    const fileSystem = new MemoryReaderFileSystem(Object.fromEntries(first.files));
    const loaded = await new PackageLoader(fileSystem).loadDetected();
    const explicitlyLoaded = await new PackageLoader(fileSystem).load("article.md");
    expect(loaded.state).toBe("mineru");
    expect(loaded.packageIntegrity).toBe("verified");
    expect(loaded.articlePath).toBe("fixture/derived/article.after-mineru.md");
    expect(loaded.articleText).toBe(new TextDecoder().decode(first.files.get("derived/article.after-mineru.md")!));
    expect(loaded.articleHash).toBe(first.manifest.derived.files[0]?.sha256);
    expect(loaded.contractPath).toBe("fixture/sidecars/reader-projection.json");
    expect(loaded.sourceArticle).toEqual({
      path: `fixture/${first.manifest.source.article_path}`,
      sha256: first.manifest.source.files.find((entry) => entry.path === first.manifest.source.article_path)?.sha256
    });
    expect(loaded.activeProjection).toEqual({
      kind: "verified-derived",
      manifestVersion: "after-mineru-package-v1",
      path: "fixture/derived/article.after-mineru.md",
      sha256: first.manifest.derived.files[0]?.sha256
    });
    expect(loaded.assets).toHaveLength(first.readerProjection.visuals.length);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      code: "after-mineru-derived-projection-verified"
    }));
    expect(loaded.visualReview).toBeUndefined();
    expect(loaded.textRecovery).toBeUndefined();
    expect(explicitlyLoaded.articlePath).toBe("fixture/derived/article.after-mineru.md");
    expect(explicitlyLoaded.articleText).toBe(loaded.articleText);
    expect(explicitlyLoaded.activeProjection).toEqual(loaded.activeProjection);
    expect(explicitlyLoaded.diagnostics).toContainEqual(expect.objectContaining({
      code: "after-mineru-derived-projection-verified"
    }));
    expect(explicitlyLoaded.visualReview).toBeUndefined();
    expect(explicitlyLoaded.textRecovery).toBeUndefined();
  }, 90_000);

  it("fails closed when any manifest-bound derived byte is changed", async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    const repaired = await repairMinerUArchive({ archiveBytes: sourceArchive });
    const tampered = new Map(repaired.files);
    const article = new Uint8Array(tampered.get("derived/article.after-mineru.md")!);
    article[0] = article[0]! ^ 1;
    tampered.set("derived/article.after-mineru.md", article);

    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(tampered)))
      .rejects.toThrow("File does not match the manifest");
    await expect(new PackageLoader(new MemoryReaderFileSystem(Object.fromEntries(tampered))).loadDetected())
      .rejects.toThrow("File does not match the manifest");
    await expect(zipAfterMinerUPackage(tampered)).rejects.toThrow("File does not match the manifest");
  }, 60_000);

  it("binds an explicitly selected PDF outside the original MinerU source tree", async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    const explicitPdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const expectedPdf = explicitPdf.slice();
    const repairPromise = repairMinerUArchive({
      archiveBytes: sourceArchive,
      sourcePdf: { bytes: explicitPdf, name: "selected.pdf" }
    });
    explicitPdf.fill(0);
    const repaired = await repairPromise;
    const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(repaired.files));

    expect(repaired.manifest.source.pdf_path).toBe("source/source.pdf");
    expect(repaired.files.get("source/source.pdf")).toEqual(expectedPdf);
    expect(verified.provenance.source_pdf_origin).toBe("explicit-selection");
    expect(verified.provenance.source_pdf?.sha256).toBe(sha256Bytes(expectedPdf));
    expect(verified.provenance.source_tree.entries.some((entry) => entry.package_path === "source/source.pdf"))
      .toBe(false);
    expect(verified.provenance.source_tree.entries).toHaveLength(verified.provenance.source_entry_count);

    const forged = new Map(repaired.files);
    const forgedManifest = structuredClone(repaired.manifest);
    const forgedPdf = expectedPdf.slice();
    forgedPdf[forgedPdf.length - 1] = forgedPdf[forgedPdf.length - 1]! ^ 1;
    const forgedHash = sha256Bytes(forgedPdf);
    forged.set("source/source.pdf", forgedPdf);
    const sourcePdfRecord = forgedManifest.source.files.find((entry) => entry.path === "source/source.pdf")!;
    sourcePdfRecord.sha256 = forgedHash;
    for (const alias of forgedManifest.compatibility.aliases.filter((entry) => entry.canonical_path === "source/source.pdf")) {
      alias.sha256 = forgedHash;
      forged.set(alias.path, forgedPdf);
    }
    forged.set(
      "after-mineru.manifest.json",
      new TextEncoder().encode(`${JSON.stringify(forgedManifest, null, 2)}\n`)
    );
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(forged)))
      .rejects.toThrow("provenance source PDF does not match the manifest");
  }, 60_000);
});
