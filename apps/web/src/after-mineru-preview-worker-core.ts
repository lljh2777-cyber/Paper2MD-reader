import {
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  type SafeZipArchiveLimits,
  validateAfterMinerUPackage
} from "../../../packages/after-mineru-contract/src/index";
import {
  AFTER_MINERU_PREVIEW_WORKER_LIMITS,
  type AfterMinerUPreviewTransferEntry
} from "./after-mineru-preview-worker-protocol";

const PREVIEW_ARCHIVE_LIMITS: Readonly<SafeZipArchiveLimits> = Object.freeze({
  archiveBytes: AFTER_MINERU_PREVIEW_WORKER_LIMITS.archiveBytes,
  fileCount: AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: AFTER_MINERU_PREVIEW_WORKER_LIMITS.totalBytes,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: AFTER_MINERU_PACKAGE_LIMITS.pathDepth
});

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * Read only the bounded EOCD footer so a mismatched handoff inventory is
 * rejected before fflate allocates any uncompressed entry buffers. The shared
 * safe ZIP parser still performs the authoritative central/local-header pass.
 */
function declaredZipEntryCount(archiveBytes: ArrayBuffer): number {
  const bytes = new Uint8Array(archiveBytes);
  const view = new DataView(archiveBytes);
  const earliestEnd = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= earliestEnd; offset -= 1) {
    if (
      view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP is missing a valid end-of-central-directory record.");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff) {
    throw new Error("ZIP uses an unsupported multi-disk or ZIP64 entry inventory.");
  }
  return totalEntries;
}

function assertExpectedFileCount(expectedFileCount: number): void {
  if (!Number.isSafeInteger(expectedFileCount)
    || expectedFileCount < 1
    || expectedFileCount > PREVIEW_ARCHIVE_LIMITS.fileCount) {
    throw new Error("The declared After-MinerU file count is invalid.");
  }
}

function standaloneBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function validateAfterMinerUPreviewArchive(
  archiveBytes: ArrayBuffer,
  expectedFileCount: number
): Promise<AfterMinerUPreviewTransferEntry[]> {
  assertExpectedFileCount(expectedFileCount);
  if (!(archiveBytes instanceof ArrayBuffer)
    || archiveBytes.byteLength < 22
    || archiveBytes.byteLength > PREVIEW_ARCHIVE_LIMITS.archiveBytes) {
    throw new Error("The After-MinerU preview archive is outside the safe compressed-size limit.");
  }
  const declaredFileCount = declaredZipEntryCount(archiveBytes);
  if (declaredFileCount !== expectedFileCount) {
    throw new Error(
      `The After-MinerU archive declares ${declaredFileCount} files; the handoff declared ${expectedFileCount}.`
    );
  }
  const entries = extractValidatedZipEntries(
    new Uint8Array(archiveBytes),
    PREVIEW_ARCHIVE_LIMITS,
    isSafeAfterMinerUPath,
    { allowDirectoryEntries: false }
  );
  if (entries.size !== expectedFileCount) {
    throw new Error(
      `The After-MinerU archive contains ${entries.size} files; the handoff declared ${expectedFileCount}.`
    );
  }
  if (!entries.has(AFTER_MINERU_MANIFEST_PATH)) throw new Error("The ZIP is not an After-MinerU package.");
  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(entries));
  return [...entries]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, data]) => ({ path, data: standaloneBuffer(data) }));
}
