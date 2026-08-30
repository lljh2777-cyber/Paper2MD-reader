import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AFTER_MINERU_PACKAGE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  type SafeZipArchiveLimits,
  validateAfterMinerUPackage
} from "../packages/after-mineru-contract/src/index";
import {
  AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH,
  AFTER_MINERU_PORTABLE_ATTRIBUTION_VERSION,
  AFTER_MINERU_PORTABLE_LIMITS,
  buildAfterMinerUExports,
  RepairExecutionCancelledError,
  type RepairProgress,
  type RepairProgressStage,
  validatePortableMarkdownExport
} from "../packages/repair-core/src/index";

const rawArchivePath = resolve(
  "sites-reader",
  "public",
  "demo",
  "debyecalculator",
  "mineru-original.mineru.zip"
);
const attributionPath = resolve(
  "sites-reader",
  "public",
  "demo",
  "debyecalculator",
  "ATTRIBUTION.md"
);

const verifiedArchiveLimits: Readonly<SafeZipArchiveLimits> = Object.freeze({
  archiveBytes: AFTER_MINERU_PACKAGE_LIMITS.compressedArchiveBytes,
  fileCount: AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: AFTER_MINERU_PACKAGE_LIMITS.totalBytes,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: AFTER_MINERU_PACKAGE_LIMITS.pathDepth
});

const expectedStages: readonly RepairProgressStage[] = [
  "inspect-source",
  "parse-content",
  "analyze-visuals",
  "materialize-derived",
  "bind-package",
  "verify-package",
  "build-portable-export",
  "compress-portable-export",
  "compress-verified-package",
  "complete"
];

function archiveWithReaderOnlySlot(sourceArchive: Uint8Array): Uint8Array {
  const entries = unzipSync(sourceArchive);
  const articlePaths = Object.keys(entries).filter((path) => /(?:^|\/)full\.md$/i.test(path));
  if (articlePaths.length !== 1) throw new Error("Expected exactly one full.md in the Debye fixture");
  const articlePath = articlePaths[0]!;
  const article = new TextDecoder().decode(entries[articlePath]!);
  entries[articlePath] = new TextEncoder().encode(
    `${article}\n\n<!-- p2md:slot id="integration-unavailable" -->\n`
  );
  return zipSync(entries, { level: 6 });
}

describe("After-MinerU dual export pipeline", () => {
  let sourceArchive: Uint8Array;
  let attribution: Uint8Array;

  beforeAll(async () => {
    const [archiveBytes, attributionBytes] = await Promise.all([
      readFile(rawArchivePath),
      readFile(attributionPath)
    ]);
    sourceArchive = new Uint8Array(archiveBytes);
    attribution = new Uint8Array(attributionBytes);
  });

  it("emits deterministic verified and portable Debye archives with complete monotonic progress", async () => {
    const progress: RepairProgress[] = [];
    const input = {
      archiveBytes: sourceArchive,
      archiveName: "debyecalculator.mineru.zip",
      attribution: { bytes: attribution }
    };

    const first = await buildAfterMinerUExports(input, {
      onProgress(update) {
        progress.push({ ...update });
      }
    });
    const second = await buildAfterMinerUExports(input);

    expect(progress.map(({ stage }) => stage)).toEqual(expectedStages);
    expect(progress.every(({ percent }) => (
      Number.isFinite(percent) && percent >= 0 && percent <= 100
    ))).toBe(true);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!.percent).toBeGreaterThanOrEqual(progress[index - 1]!.percent);
    }
    expect(progress.at(-1)).toEqual({ stage: "complete", percent: 100 });

    const verifiedFiles = extractValidatedZipEntries(
      first.verifiedPackage.archiveBytes,
      verifiedArchiveLimits,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(verifiedFiles));
    expect(verified.manifest).toEqual(first.verifiedPackage.manifest);
    expect(verified.validation).toEqual(first.verifiedPackage.validation);

    expect(first.portableMarkdown.status).toBe("ready");
    expect(second.portableMarkdown.status).toBe("ready");
    if (first.portableMarkdown.status !== "ready" || second.portableMarkdown.status !== "ready") {
      throw new Error("The real Debye fixture must support the portable Markdown export");
    }
    const portableFiles = extractValidatedZipEntries(
      first.portableMarkdown.output.archiveBytes,
      AFTER_MINERU_PORTABLE_LIMITS,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    expect(validatePortableMarkdownExport(portableFiles)).toEqual(first.portableMarkdown.output.manifest);
    expect(first.portableMarkdown.output.manifest).toMatchObject({
      schema_version: 2,
      contract: AFTER_MINERU_PORTABLE_ATTRIBUTION_VERSION
    });
    expect(portableFiles.get(AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH)).toEqual(attribution);
    expect(first.portableMarkdown.output.manifest.attribution).toEqual({
      path: AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH,
      size: attribution.byteLength,
      sha256: sha256Bytes(attribution)
    });
    const tamperedAttribution = new Map(portableFiles);
    const changedAttribution = tamperedAttribution.get(AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH)!.slice();
    changedAttribution[0] = changedAttribution[0]! ^ 1;
    tamperedAttribution.set(AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH, changedAttribution);
    expect(() => validatePortableMarkdownExport(tamperedAttribution)).toThrow(/does not match its manifest/);
    const missingAttribution = new Map(portableFiles);
    missingAttribution.delete(AFTER_MINERU_PORTABLE_ATTRIBUTION_PATH);
    expect(() => validatePortableMarkdownExport(missingAttribution)).toThrow(/inventory is not exact/);

    expect(second.verifiedPackage.archiveBytes).toEqual(first.verifiedPackage.archiveBytes);
    expect(sha256Bytes(second.verifiedPackage.archiveBytes)).toBe(
      sha256Bytes(first.verifiedPackage.archiveBytes)
    );
    expect(second.portableMarkdown.output.archiveBytes).toEqual(first.portableMarkdown.output.archiveBytes);
    expect(sha256Bytes(second.portableMarkdown.output.archiveBytes)).toBe(
      sha256Bytes(first.portableMarkdown.output.archiveBytes)
    );
    expect(second.portableMarkdown.output.manifest).toEqual(first.portableMarkdown.output.manifest);
  }, 180_000);

  it("rejects a pre-aborted dual export before progress or output", async () => {
    const controller = new AbortController();
    const progress: RepairProgress[] = [];
    controller.abort();

    await expect(buildAfterMinerUExports(
      { archiveBytes: sourceArchive, archiveName: "debyecalculator.mineru.zip" },
      {
        signal: controller.signal,
        onProgress(update) {
          progress.push(update);
        }
      }
    )).rejects.toBeInstanceOf(RepairExecutionCancelledError);
    expect(progress).toEqual([]);
  });

  it("still returns a verified package when the portable projection is unavailable", async () => {
    const result = await buildAfterMinerUExports({
      archiveBytes: archiveWithReaderOnlySlot(sourceArchive),
      archiveName: "debyecalculator-reader-slot.mineru.zip"
    });

    expect(result.portableMarkdown).toEqual({
      status: "unavailable",
      reason: "reader-slots-not-materialized"
    });
    const verifiedFiles = extractValidatedZipEntries(
      result.verifiedPackage.archiveBytes,
      verifiedArchiveLimits,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(verifiedFiles));
    expect(verified.manifest).toEqual(result.verifiedPackage.manifest);
    expect(verified.validation).toEqual(result.verifiedPackage.validation);
  }, 120_000);
});
