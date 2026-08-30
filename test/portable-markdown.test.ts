import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AFTER_MINERU_MANIFEST_PATH,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  type AfterMinerUFileRecord,
  type AfterMinerUManifest,
  type AfterMinerUReaderProjection,
  validateAfterMinerUPackage
} from "../packages/after-mineru-contract/src/index";
import {
  AFTER_MINERU_PORTABLE_ARTICLE_PATH,
  AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH,
  AFTER_MINERU_PORTABLE_ATTRIBUTION_VERSION,
  AFTER_MINERU_PORTABLE_LIMITS,
  AFTER_MINERU_PORTABLE_MANIFEST_PATH,
  AFTER_MINERU_PORTABLE_VERSION,
  buildPortableMarkdownExport,
  validatePortableMarkdownExport
} from "../packages/repair-core/src/portable-markdown";
import {
  extractMarkdownImageOccurrences,
  repairMinerUArchive,
  type RepairMinerUArchiveResult
} from "../packages/repair-core/src/index";

const rawArchivePath = resolve(
  "sites-reader",
  "public",
  "demo",
  "debyecalculator",
  "mineru-original.mineru.zip"
);

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function fileRecord(path: string, bytes: Uint8Array): AfterMinerUFileRecord {
  return { path, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

async function withDerivedArticle(
  repaired: RepairMinerUArchiveResult,
  markdown: string
): Promise<{
  files: ReadonlyMap<string, Uint8Array>;
  manifest: AfterMinerUManifest;
  readerProjection: AfterMinerUReaderProjection;
}> {
  const files = new Map<string, Uint8Array>(
    [...repaired.files].map(([path, bytes]) => [path, bytes.slice()])
  );
  const manifest = structuredClone(repaired.manifest);
  const readerProjection = structuredClone(repaired.readerProjection);
  const articleBytes = new TextEncoder().encode(markdown);
  const articleRecord = fileRecord(manifest.derived.article_path, articleBytes);
  files.set(manifest.derived.article_path, articleBytes);
  manifest.derived.files = manifest.derived.files.map((entry) => (
    entry.path === manifest.derived.article_path ? articleRecord : entry
  ));
  readerProjection.inputs.derived_article = articleRecord;
  const projectionBytes = jsonBytes(readerProjection);
  files.set(manifest.sidecars.reader_projection_path, projectionBytes);
  const projectionRecord = manifest.sidecars.files.find((entry) => (
    entry.path === manifest.sidecars.reader_projection_path
  ))!;
  Object.assign(projectionRecord, fileRecord(projectionRecord.path, projectionBytes));

  const provenance = decodeJson(files.get(manifest.sidecars.provenance_path)!);
  provenance.derived_article = articleRecord;
  const provenanceBytes = jsonBytes(provenance);
  files.set(manifest.sidecars.provenance_path, provenanceBytes);
  const provenanceRecord = manifest.sidecars.files.find((entry) => (
    entry.path === manifest.sidecars.provenance_path
  ))!;
  Object.assign(provenanceRecord, fileRecord(provenanceRecord.path, provenanceBytes));
  files.set(AFTER_MINERU_MANIFEST_PATH, jsonBytes(manifest));

  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(files));
  return { files, manifest, readerProjection };
}

describe("portable After-MinerU Markdown export", () => {
  let repaired: RepairMinerUArchiveResult;

  beforeAll(async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    repaired = await repairMinerUArchive({
      archiveBytes: sourceArchive,
      archiveName: "debyecalculator.mineru.zip"
    });
  }, 90_000);

  it("exports the real Debye Markdown with an exact image closure and explicit PDF-crop fallback", async () => {
    const first = await buildPortableMarkdownExport({
      archiveName: repaired.archiveName,
      verifiedPackageFiles: repaired.files,
      manifest: repaired.manifest,
      readerProjection: repaired.readerProjection
    });
    const second = await buildPortableMarkdownExport({
      archiveName: repaired.archiveName,
      verifiedPackageFiles: repaired.files,
      manifest: repaired.manifest,
      readerProjection: repaired.readerProjection
    });

    expect(first.archiveName).toBe("debyecalculator.after-mineru-markdown.zip");
    expect(first.manifest).toMatchObject({
      schema_version: 1,
      contract: AFTER_MINERU_PORTABLE_VERSION
    });
    expect(first.manifest.representation).toBe("source-assets-fallback");
    expect(first.manifest.warnings).toEqual([
      { code: "pdf-crop-not-materialized", count: 1 }
    ]);
    expect(first.manifest.assets).toHaveLength(6);
    expect(first.manifest.assets.map(({ path }) => path)).toEqual(
      [...first.manifest.assets.map(({ path }) => path)].sort()
    );
    const extracted = extractValidatedZipEntries(
      first.archiveBytes,
      AFTER_MINERU_PORTABLE_LIMITS,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    expect([...extracted.keys()].filter((path) => /\.pdf$|\.json$/i.test(path))).toEqual([
      AFTER_MINERU_PORTABLE_MANIFEST_PATH
    ]);
    expect(extracted.has(AFTER_MINERU_PORTABLE_ARTICLE_PATH)).toBe(true);
    for (const asset of first.manifest.assets) {
      expect(extracted.get(asset.path)).toEqual(repaired.files.get(asset.path));
    }
    expect(validatePortableMarkdownExport(extracted)).toEqual(first.manifest);
    expect(extracted.size).toBe(first.fileCount);
    expect(second.archiveBytes).toEqual(first.archiveBytes);
    expect(sha256Bytes(second.archiveBytes)).toBe(sha256Bytes(first.archiveBytes));
    expect(second.manifest).toEqual(first.manifest);
  }, 90_000);

  it("reserves exactly one v2 inventory slot for attribution", () => {
    const buildBoundaryFiles = (assetCount: number): Map<string, Uint8Array> => {
      const assetBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const assetPaths = Array.from({ length: assetCount }, (_, index) => (
        `images/asset-${String(index).padStart(3, "0")}.png`
      ));
      const articleBytes = new TextEncoder().encode(
        `# Portable boundary\n\n${assetPaths.map((path) => `![](${path})`).join("\n")}\n`
      );
      const attributionBytes = new TextEncoder().encode("# Attribution\n");
      const manifest = {
        schema_version: 2,
        contract: AFTER_MINERU_PORTABLE_ATTRIBUTION_VERSION,
        algorithm_version: "boundary-test-v1",
        source_archive_sha256: "00".repeat(32),
        representation: "portable-derived",
        article: fileRecord(AFTER_MINERU_PORTABLE_ARTICLE_PATH, articleBytes),
        assets: assetPaths.map((path) => fileRecord(path, assetBytes)),
        attribution: fileRecord(AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH, attributionBytes),
        warnings: []
      };
      return new Map<string, Uint8Array>([
        [AFTER_MINERU_PORTABLE_MANIFEST_PATH, jsonBytes(manifest)],
        [AFTER_MINERU_PORTABLE_ARTICLE_PATH, articleBytes],
        ...assetPaths.map((path): [string, Uint8Array] => [path, assetBytes]),
        [AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH, attributionBytes]
      ]);
    };

    const maximum = buildBoundaryFiles(AFTER_MINERU_PORTABLE_LIMITS.fileCount - 3);
    expect(maximum.size).toBe(AFTER_MINERU_PORTABLE_LIMITS.fileCount);
    const maximumManifest = validatePortableMarkdownExport(maximum);
    expect(maximumManifest).toMatchObject({
      schema_version: 2,
      contract: AFTER_MINERU_PORTABLE_ATTRIBUTION_VERSION
    });
    expect(maximumManifest.assets).toHaveLength(AFTER_MINERU_PORTABLE_LIMITS.fileCount - 3);

    const overflow = buildBoundaryFiles(AFTER_MINERU_PORTABLE_LIMITS.fileCount - 2);
    expect(overflow.size).toBe(AFTER_MINERU_PORTABLE_LIMITS.fileCount + 1);
    expect(() => validatePortableMarkdownExport(overflow)).toThrow(/unsupported|limit|inventory/i);
  });

  it("rejects unsafe image paths and Reader-only slots with stable unavailable reasons", async () => {
    const traversal = await withDerivedArticle(repaired, "# Unsafe\n\n![outside](../outside.png)\n");
    await expect(buildPortableMarkdownExport({
      archiveName: "unsafe.zip",
      verifiedPackageFiles: traversal.files,
      manifest: traversal.manifest,
      readerProjection: traversal.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "unsafe-asset-reference"
    });

    const backslash = await withDerivedArticle(repaired, "# Unsafe\n\n![outside](images\\outside.png)\n");
    await expect(buildPortableMarkdownExport({
      archiveName: "backslash.zip",
      verifiedPackageFiles: backslash.files,
      manifest: backslash.manifest,
      readerProjection: backslash.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "unsafe-asset-reference"
    });

    for (const image of [
      "![encoded traversal](%2e%2e/outside.png)",
      "![remote](https://example.com/outside.png)",
      "![query](images/outside.png?variant=1)"
    ]) {
      const unsafe = await withDerivedArticle(repaired, `# Unsafe\n\n${image}\n`);
      await expect(buildPortableMarkdownExport({
        archiveName: "unsafe-reference.zip",
        verifiedPackageFiles: unsafe.files,
        manifest: unsafe.manifest,
        readerProjection: unsafe.readerProjection
      })).rejects.toMatchObject({
        name: "PortableMarkdownUnavailableError",
        reason: "unsafe-asset-reference"
      });
    }

    const referenceStyle = await withDerivedArticle(
      repaired,
      "# Unsupported\n\n![reference style][figure]\n\n[figure]: images/figure.png\n"
    );
    await expect(buildPortableMarkdownExport({
      archiveName: "unsupported-image-syntax.zip",
      verifiedPackageFiles: referenceStyle.files,
      manifest: referenceStyle.manifest,
      readerProjection: referenceStyle.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "missing-source-asset"
    });

    for (const image of [
      "![balanced destination](images/a.png(foo.png))",
      '<img src="https://tracker.example/outside.png" src="images/local.png">',
      '<img src="images/local.png" srcset="images/other.png 2x">',
      '<picture><source srcset="images/local.png 2x"><img src="images/local.png"></picture>',
      '<svg><image href="https://tracker.example/outside.png"></image></svg>',
      '<div style="background-image:url(https://tracker.example/outside.png)"></div>',
      '<custom-image src="https://tracker.example/outside.png"></custom-image>',
      '<img src="images/a&amp;b.png">',
      '<div title=">" style="background-image:url(https://tracker.example/outside.png)"></div>',
      '<div\nclass="x"\nstyle="background-image:url(https://tracker.example/outside.png)"></div>',
      '<math><mglyph src="https://tracker.example/outside.png"></mglyph></math>',
      '<!--safe--><img src="https://tracker.example/outside.png"><!--tail-->',
      '<!--safe--!><img src="https://tracker.example/outside.png"><!--tail-->'
    ]) {
      const unsupportedHtml = await withDerivedArticle(repaired, `# Unsupported HTML\n\n${image}\n`);
      await expect(buildPortableMarkdownExport({
        archiveName: "unsupported-html-image.zip",
        verifiedPackageFiles: unsupportedHtml.files,
        manifest: unsupportedHtml.manifest,
        readerProjection: unsupportedHtml.readerProjection
      })).rejects.toMatchObject({
        name: "PortableMarkdownUnavailableError",
        reason: "unsupported-image-syntax"
      });
    }

    const tooManyImages = await withDerivedArticle(
      repaired,
      Array.from({ length: AFTER_MINERU_PORTABLE_LIMITS.fileCount - 1 }, (_, index) => (
        `![asset ${index}](images/asset-${index}.png)`
      )).join("\n")
    );
    await expect(buildPortableMarkdownExport({
      archiveName: "too-many-assets.zip",
      verifiedPackageFiles: tooManyImages.files,
      manifest: tooManyImages.manifest,
      readerProjection: tooManyImages.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "portable-size-limit-exceeded"
    });

    const slot = await withDerivedArticle(
      repaired,
      "# Reader only\n\n<!-- p2md:slot id=\"block-1\" asset=\"asset-1\" -->\n"
    );
    await expect(buildPortableMarkdownExport({
      archiveName: "slot.zip",
      verifiedPackageFiles: slot.files,
      manifest: slot.manifest,
      readerProjection: slot.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "reader-slots-not-materialized"
    });
  }, 90_000);

  it("stores highly repetitive image assets so its own safe ZIP validator can reopen them", async () => {
    const largeBitmap = new Uint8Array(2 * 1024 * 1024);
    largeBitmap[0] = 0x42;
    largeBitmap[1] = 0x4d;
    const sourceArchive = zipSync({
      "result/full.md": strToU8("# Paper\n\n![](images/figure.bmp)\n\nFigure 1. Repetitive bitmap.\n"),
      "result/full_content_list.json": strToU8(JSON.stringify([{
        type: "image",
        img_path: "images/figure.bmp",
        image_caption: ["Figure 1. Repetitive bitmap."],
        page_idx: 0,
        bbox: [10, 10, 900, 900]
      }])),
      "result/images/figure.bmp": largeBitmap
    }, { level: 0 });
    const highRatioRepair = await repairMinerUArchive({
      archiveBytes: sourceArchive,
      archiveName: "repetitive-bitmap.mineru.zip"
    });
    const built = await buildPortableMarkdownExport({
      archiveName: highRatioRepair.archiveName,
      verifiedPackageFiles: highRatioRepair.files,
      manifest: highRatioRepair.manifest,
      readerProjection: highRatioRepair.readerProjection
    });
    const extracted = extractValidatedZipEntries(
      built.archiveBytes,
      AFTER_MINERU_PORTABLE_LIMITS,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );

    expect(built.archiveBytes.byteLength).toBeGreaterThan(largeBitmap.byteLength);
    expect(validatePortableMarkdownExport(extracted)).toEqual(built.manifest);
    expect(extracted.get("images/figure.bmp")).toEqual(largeBitmap);
  }, 90_000);

  it("fails closed when a Reader visual fallback is not fully referenced", async () => {
    const sourceArticle = new TextDecoder().decode(repaired.files.get(repaired.manifest.source.article_path)!);
    const occurrences = extractMarkdownImageOccurrences(sourceArticle);
    const assetVisualPaths = new Set(repaired.readerProjection.visuals
      .filter((visual) => visual.display.mode === "asset")
      .map((visual) => visual.path));
    const retainedTokens = occurrences
      .filter((occurrence) => assetVisualPaths.has(occurrence.asset_path))
      .map((occurrence) => sourceArticle.slice(occurrence.char_start, occurrence.char_end));
    expect(retainedTokens).toHaveLength(assetVisualPaths.size);
    const incomplete = await withDerivedArticle(
      repaired,
      `# Incomplete fallback\n\n${retainedTokens.join("\n\n")}\n`
    );

    await expect(buildPortableMarkdownExport({
      archiveName: "incomplete.zip",
      verifiedPackageFiles: incomplete.files,
      manifest: incomplete.manifest,
      readerProjection: incomplete.readerProjection
    })).rejects.toMatchObject({
      name: "PortableMarkdownUnavailableError",
      reason: "fallback-assets-incomplete"
    });
  }, 90_000);

  it("records a fragment-set fallback only when every member image remains portable", async () => {
    const files = new Map<string, Uint8Array>(
      [...repaired.files].map(([path, bytes]) => [path, bytes.slice()])
    );
    const manifest = structuredClone(repaired.manifest);
    const readerProjection = structuredClone(repaired.readerProjection);
    const grouped = readerProjection.visuals.find((visual) => visual.display.mode === "pdf-crop")!;
    grouped.display = {
      mode: "fragment-set",
      fragments: grouped.member_asset_paths.map((path) => ({
        path,
        bbox: { x: 0, y: 0, width: 1, height: 1 }
      }))
    };
    const projectionBytes = jsonBytes(readerProjection);
    files.set(manifest.sidecars.reader_projection_path, projectionBytes);
    const projectionRecord = manifest.sidecars.files.find((entry) => (
      entry.path === manifest.sidecars.reader_projection_path
    ))!;
    Object.assign(projectionRecord, fileRecord(projectionRecord.path, projectionBytes));
    files.set(AFTER_MINERU_MANIFEST_PATH, jsonBytes(manifest));
    await validateAfterMinerUPackage(mapAfterMinerUPackageReader(files));

    const built = await buildPortableMarkdownExport({
      archiveName: repaired.archiveName,
      verifiedPackageFiles: files,
      manifest,
      readerProjection
    });
    expect(built.manifest.warnings).toEqual([
      { code: "fragment-set-not-materialized", count: 1 }
    ]);
    expect(built.manifest.assets).toHaveLength(6);
  }, 90_000);

  it("rejects modified assets, articles, and extra files after export", async () => {
    const built = await buildPortableMarkdownExport({
      archiveName: repaired.archiveName,
      verifiedPackageFiles: repaired.files,
      manifest: repaired.manifest,
      readerProjection: repaired.readerProjection
    });
    const firstAsset = built.manifest.assets[0]!;
    const baseFiles = extractValidatedZipEntries(
      built.archiveBytes,
      AFTER_MINERU_PORTABLE_LIMITS,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );

    const changedAsset = new Map(baseFiles);
    const assetBytes = changedAsset.get(firstAsset.path)!.slice();
    assetBytes[0] = assetBytes[0]! ^ 1;
    changedAsset.set(firstAsset.path, assetBytes);
    expect(() => validatePortableMarkdownExport(changedAsset)).toThrow(/does not match its manifest/);

    const changedArticle = new Map(baseFiles);
    changedArticle.set(
      AFTER_MINERU_PORTABLE_ARTICLE_PATH,
      new TextEncoder().encode("# changed\n")
    );
    expect(() => validatePortableMarkdownExport(changedArticle)).toThrow(/does not match its manifest/);

    const extraFile = new Map(baseFiles);
    extraFile.set("images/unlisted.png", new Uint8Array([1]));
    expect(() => validatePortableMarkdownExport(extraFile)).toThrow(/inventory is not exact/);
  }, 90_000);
});
