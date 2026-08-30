import {
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  type SafeZipArchiveLimits,
  validateAfterMinerUPackage
} from "../../../packages/after-mineru-contract/src/index";
import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";
import { PackageLimitError } from "../../../src/model/package-limits";

const ARCHIVE_LIMITS: Readonly<SafeZipArchiveLimits> = Object.freeze({
  archiveBytes: AFTER_MINERU_PACKAGE_LIMITS.compressedArchiveBytes,
  fileCount: AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: AFTER_MINERU_PACKAGE_LIMITS.totalBytes,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: AFTER_MINERU_PACKAGE_LIMITS.pathDepth
});

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".zip": "application/zip"
};

function mimeType(path: string): string {
  const extension = /\.[^.]+$/.exec(path.toLowerCase())?.[0] ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function assertAfterMinerUArchiveByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 22 || byteLength > ARCHIVE_LIMITS.archiveBytes) {
    throw new PackageLimitError(
      `The After-MinerU archive is ${byteLength} bytes; the safe limit is ${ARCHIVE_LIMITS.archiveBytes}.`,
      byteLength,
      ARCHIVE_LIMITS.archiveBytes
    );
  }
}

export async function extractAfterMinerUArchiveBytes(bytes: Uint8Array): Promise<Map<string, File>> {
  assertAfterMinerUArchiveByteLength(bytes.byteLength);
  const entries = extractValidatedZipEntries(
    bytes,
    ARCHIVE_LIMITS,
    isSafeAfterMinerUPath,
    { allowDirectoryEntries: false }
  );
  if (!entries.has(AFTER_MINERU_MANIFEST_PATH)) throw new Error("The ZIP is not an After-MinerU package.");
  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(entries));
  return new Map([...entries].map(([path, data]) => [
    path,
    new File([
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    ], path.split("/").pop() ?? path, { type: mimeType(path) })
  ]));
}

export interface AfterMinerUArchiveImportOptions {
  expectedFileCount?: number;
}

function assertExpectedFileCount(files: ReadonlyMap<string, File>, expectedFileCount: number | undefined): void {
  if (expectedFileCount === undefined) return;
  if (!Number.isSafeInteger(expectedFileCount)
    || expectedFileCount < 1
    || expectedFileCount > AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount) {
    throw new Error("The declared After-MinerU file count is invalid.");
  }
  if (files.size !== expectedFileCount) {
    throw new Error(
      `The After-MinerU archive contains ${files.size} files; the handoff declared ${expectedFileCount}.`
    );
  }
}

export async function importAfterMinerUArchiveBytes(
  bytes: ArrayBuffer,
  archiveName: string,
  options: AfterMinerUArchiveImportOptions = {}
): Promise<BrowserDirectoryReaderFileSystem> {
  assertAfterMinerUArchiveByteLength(bytes.byteLength);
  const files = await extractAfterMinerUArchiveBytes(new Uint8Array(bytes));
  assertExpectedFileCount(files, options.expectedFileCount);
  return BrowserDirectoryReaderFileSystem.fromAfterMinerUArchive(afterMinerUArchiveRootLabel(archiveName), files);
}

export async function importAfterMinerUArchiveFile(
  file: File,
  options: AfterMinerUArchiveImportOptions = {}
): Promise<BrowserDirectoryReaderFileSystem> {
  assertAfterMinerUArchiveByteLength(file.size);
  return importAfterMinerUArchiveBytes(await file.arrayBuffer(), file.name, options);
}

export function afterMinerUArchiveRootLabel(filename: string): string {
  const label = filename.replace(/\.after-mineru\.zip$/i, "").trim();
  return label || "After-MinerU package";
}
