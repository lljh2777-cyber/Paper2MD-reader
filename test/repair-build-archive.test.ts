import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AFTER_MINERU_PACKAGE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  validateAfterMinerUPackage,
  type SafeZipArchiveLimits
} from "../packages/after-mineru-contract/src/index";
import {
  AFTER_MINERU_REPAIR_REPORT_PATH,
  buildAfterMinerUArchive,
  RepairExecutionCancelledError,
  type RepairProgress,
  type RepairProgressStage
} from "../packages/repair-core/src/index";

const rawArchivePath = resolve(
  "sites-reader",
  "public",
  "demo",
  "debyecalculator",
  "mineru-original.mineru.zip"
);

const outputArchiveLimits: Readonly<SafeZipArchiveLimits> = Object.freeze({
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
  "compress-package",
  "complete"
];

describe("After-MinerU build archive pipeline", () => {
  it("reports monotonic progress and deterministically emits a verified Debye package with a bound report", async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    const mutableSourceArchive = sourceArchive.slice();
    const progress: RepairProgress[] = [];
    const input = {
      archiveBytes: mutableSourceArchive,
      archiveName: "debyecalculator.mineru.zip"
    };

    const first = await buildAfterMinerUArchive(input, {
      onProgress(update) {
        if (update.stage === "inspect-source") mutableSourceArchive.fill(0);
        progress.push({ ...update });
      }
    });
    const second = await buildAfterMinerUArchive({
      archiveBytes: sourceArchive,
      archiveName: "debyecalculator.mineru.zip"
    });

    expect(progress.map(({ stage }) => stage)).toEqual(expectedStages);
    expect(progress.every(({ percent }) => Number.isFinite(percent) && percent >= 0 && percent <= 100)).toBe(true);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!.percent).toBeGreaterThanOrEqual(progress[index - 1]!.percent);
    }
    expect(progress.at(-1)).toEqual({ stage: "complete", percent: 100 });
    expect(first.files.get("source/mineru-original.mineru.zip")).toEqual(sourceArchive);

    const extracted = extractValidatedZipEntries(
      first.archiveBytes,
      outputArchiveLimits,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(extracted));
    expect(verified.manifest).toEqual(first.manifest);
    expect(verified.validation).toEqual(first.validation);

    const reportBytes = extracted.get(AFTER_MINERU_REPAIR_REPORT_PATH);
    const reportRecord = verified.manifest.sidecars.files.find(
      ({ path }) => path === AFTER_MINERU_REPAIR_REPORT_PATH
    );
    expect(reportBytes).toBeDefined();
    expect(reportRecord).toEqual({
      path: AFTER_MINERU_REPAIR_REPORT_PATH,
      size: reportBytes!.byteLength,
      sha256: sha256Bytes(reportBytes!)
    });
    expect(JSON.parse(new TextDecoder().decode(reportBytes!))).toEqual(first.report);

    const tampered = new Map(extracted);
    const tamperedReport = reportBytes!.slice();
    tamperedReport[tamperedReport.byteLength - 2] = tamperedReport[tamperedReport.byteLength - 2]! ^ 1;
    tampered.set(AFTER_MINERU_REPAIR_REPORT_PATH, tamperedReport);
    await expect(validateAfterMinerUPackage(mapAfterMinerUPackageReader(tampered))).rejects.toThrow();

    expect(second.report).toEqual(first.report);
    expect(second.files.get(AFTER_MINERU_REPAIR_REPORT_PATH)).toEqual(first.files.get(AFTER_MINERU_REPAIR_REPORT_PATH));
    expect(second.archiveBytes).toEqual(first.archiveBytes);
    expect(sha256Bytes(second.archiveBytes)).toBe(sha256Bytes(first.archiveBytes));
  }, 120_000);

  it("rejects a pre-aborted build before reporting or producing output", async () => {
    const sourceArchive = new Uint8Array(await readFile(rawArchivePath));
    const controller = new AbortController();
    const progress: RepairProgress[] = [];
    controller.abort();

    await expect(buildAfterMinerUArchive(
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
});
