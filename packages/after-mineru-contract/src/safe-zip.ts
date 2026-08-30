import { unzipSync } from "fflate";

export interface SafeZipArchiveLimits {
  archiveBytes: number;
  fileCount: number;
  fileBytes: number;
  totalBytes: number;
  compressionRatio: number;
  pathDepth: number;
}

export interface SafeZipExtractionOptions {
  allowDirectoryEntries?: boolean;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const FORBIDDEN_OBJECT_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_value, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

interface ZipEntryMetadata {
  path: string;
  crc32: number;
  compressedSize: number;
  originalSize: number;
  directory: boolean;
}

function normalizeArchivePath(rawPath: string): string {
  // ZIP paths are compared byte-for-byte with a signed manifest/tree. Do not
  // trim, URL-decode, or reinterpret backslashes as separators.
  const normalized = rawPath;
  const segments = normalized.split("/");
  if (
    !normalized
    || rawPath !== rawPath.trim()
    || normalized.includes("\\")
    || normalized.includes("\0")
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || normalized.startsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("ZIP 含不安全路径。 ZIP contains an unsafe path.");
  }
  if (
    normalized.length > 1024
    || segments.some((segment) => (
      segment.length > 255
      || /[\u0000-\u001f<>:"|?*#]/u.test(segment)
      || /[. ]$/u.test(segment)
      || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
      || FORBIDDEN_OBJECT_PATH_SEGMENTS.has(segment.toLocaleLowerCase("en-US"))
    ))
  ) {
    throw new Error("ZIP 含不兼容本地文件系统的路径。 ZIP contains a path that is unsafe for local or object-backed storage.");
  }
  if (segments.some((segment) => segment.normalize("NFC") !== segment)) {
    throw new Error("ZIP contains a non-canonical Unicode path.");
  }
  return normalized;
}

function canonicalArchivePath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new Error("ZIP contains a non-ASCII name that is not declared as UTF-8.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP contains an invalid UTF-8 name.");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function inspectZipStructure(
  bytes: Uint8Array,
  limits: Readonly<SafeZipArchiveLimits>,
  allowedPath: (path: string) => boolean,
  options: Readonly<SafeZipExtractionOptions>
): Map<string, ZipEntryMetadata> {
  if (bytes.byteLength < 22) throw new Error("ZIP structure is incomplete.");
  if (bytes.byteLength > limits.archiveBytes) throw new Error("ZIP exceeds the safe archive-size limit.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
  if (endOffset < 0) throw new Error("ZIP 缺少有效中央目录。 ZIP is missing a valid central directory.");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    disk
    || centralDisk
    || diskEntries !== totalEntries
    || totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize !== endOffset
  ) {
    throw new Error("ZIP uses an unsupported multi-disk, ZIP64, or central-directory layout.");
  }
  if (totalEntries > limits.fileCount) throw new Error("ZIP entry count exceeds the safe limit.");

  const metadata = new Map<string, ZipEntryMetadata>();
  const canonicalPaths = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let declaredTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) {
      throw new Error("ZIP central-directory entry is invalid.");
    }
    const versionMadeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (
      !nameLength
      || nextOffset > endOffset
      || compressedSize === 0xffffffff
      || originalSize === 0xffffffff
      || localOffset === 0xffffffff
      || diskStart !== 0
      || (flags & 0x2061) !== 0
      || (method !== 0 && method !== 8)
    ) {
      throw new Error("ZIP contains an encrypted, unsupported, or out-of-ZIP32 entry.");
    }
    const centralName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeZipName(centralName, Boolean(flags & 0x800));
    const directory = rawName.endsWith("/");
    const path = normalizeArchivePath(directory ? rawName.slice(0, -1) : rawName);
    const canonicalPath = canonicalArchivePath(path);
    if (metadata.has(path) || canonicalPaths.has(canonicalPath)) throw new Error("ZIP 含重复或落盘冲突路径。 ZIP contains a duplicate or landing-conflicting path.");
    canonicalPaths.add(canonicalPath);
    if (path.split("/").length > limits.pathDepth || (!directory && !allowedPath(path))) {
      throw new Error("ZIP 含不支持的文件。 ZIP contains an unsupported file.");
    }
    if (directory && options.allowDirectoryEntries === false) {
      throw new Error(`Formal ZIP contains an unmanifested directory entry: ${path}/`);
    }
    const unixMode = versionMadeBy >>> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error("ZIP contains an unsupported symbolic link.");
    if (directory && (compressedSize !== 0 || originalSize !== 0)) throw new Error("ZIP 目录条目含异常数据。 ZIP directory entry contains unexpected data.");
    if (!directory) {
      declaredTotal += originalSize;
      if (originalSize < 1 || originalSize > limits.fileBytes || declaredTotal > limits.totalBytes) {
        throw new Error("ZIP uncompressed size exceeds the safe limit.");
      }
      if (
        originalSize > 1024 * 1024
        && compressedSize > 0
        && originalSize / compressedSize > limits.compressionRatio
      ) {
        throw new Error("ZIP entry compression ratio exceeds the safe limit.");
      }
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER) {
      throw new Error("ZIP local header is invalid.");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags
      || localMethod !== method
      || dataEnd > centralOffset
      || !sameBytes(centralName, bytes.subarray(localNameStart, localNameStart + localNameLength))
    ) {
      throw new Error("ZIP 本地文件头与中央目录冲突。 ZIP local header conflicts with the central directory.");
    }
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localOriginalSize = view.getUint32(localOffset + 22, true);
    let recordEnd = dataEnd;
    if (flags & 0x08) {
      if (
        (localCrc !== 0 && localCrc !== expectedCrc)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localOriginalSize !== 0 && localOriginalSize !== originalSize)
        || dataEnd + 12 > centralOffset
      ) {
        throw new Error("ZIP local-header checks conflict with the central directory.");
      }
      const descriptorEnds: number[] = [];
      if (
        dataEnd + 12 <= centralOffset
        && view.getUint32(dataEnd, true) === expectedCrc
        && view.getUint32(dataEnd + 4, true) === compressedSize
        && view.getUint32(dataEnd + 8, true) === originalSize
      ) descriptorEnds.push(dataEnd + 12);
      if (
        dataEnd + 16 <= centralOffset
        && view.getUint32(dataEnd, true) === 0x08074b50
        && view.getUint32(dataEnd + 4, true) === expectedCrc
        && view.getUint32(dataEnd + 8, true) === compressedSize
        && view.getUint32(dataEnd + 12, true) === originalSize
      ) descriptorEnds.push(dataEnd + 16);
      if (descriptorEnds.length !== 1) throw new Error("ZIP 数据描述符与中央目录冲突。 ZIP data descriptor conflicts with the central directory.");
      recordEnd = descriptorEnds[0]!;
    } else if (
      localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localOriginalSize !== originalSize
    ) {
      throw new Error("ZIP local-header checks conflict with the central directory.");
    }
    ranges.push({ start: localOffset, end: recordEnd });
    metadata.set(path, { path, crc32: expectedCrc, compressedSize, originalSize, directory });
    offset = nextOffset;
  }
  if (offset !== endOffset) throw new Error("ZIP central-directory length is inconsistent.");
  ranges.sort((left, right) => left.start - right.start);
  if (ranges[0]?.start !== 0 || ranges[ranges.length - 1]?.end !== centralOffset) {
    throw new Error("ZIP 本地记录区含未登记数据。 ZIP local-record area contains unregistered data.");
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start !== ranges[index - 1]!.end) {
      throw new Error(
        ranges[index]!.start < ranges[index - 1]!.end
          ? "ZIP entry data overlaps."
          : "ZIP 本地记录区含未登记数据。 ZIP local-record area contains unregistered data."
      );
    }
  }
  return metadata;
}

/**
 * Extract a ZIP only after checking its complete central/local-header layout,
 * path collisions, compression ratios, uncompressed limits, and per-entry
 * CRC. Callers supply the format-specific path allowlist.
 */
export function extractValidatedZipEntries(
  bytes: Uint8Array,
  limits: Readonly<SafeZipArchiveLimits>,
  allowedPath: (path: string) => boolean,
  options: Readonly<SafeZipExtractionOptions> = {}
): Map<string, Uint8Array> {
  const structure = inspectZipStructure(bytes, limits, allowedPath, options);
  const seenPaths = new Set<string>();
  const extracted = unzipSync(bytes, {
    filter: (entry) => {
      const directory = entry.name.endsWith("/");
      const path = normalizeArchivePath(directory ? entry.name.slice(0, -1) : entry.name);
      const canonicalPath = canonicalArchivePath(path);
      if (seenPaths.has(canonicalPath)) throw new Error("ZIP 含重复或落盘冲突路径。 ZIP contains a duplicate or landing-conflicting path.");
      seenPaths.add(canonicalPath);
      return !directory;
    }
  });
  const entries = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const rawPath of Object.keys(extracted)) {
    const content = extracted[rawPath]!;
    const path = normalizeArchivePath(rawPath);
    const header = structure.get(path);
    if (!header || header.directory || header.originalSize !== content.byteLength || header.crc32 !== crc32(content)) {
      throw new Error("ZIP entry size or CRC check failed.");
    }
    actualTotal += content.byteLength;
    if (content.byteLength < 1 || content.byteLength > limits.fileBytes || actualTotal > limits.totalBytes) {
      throw new Error("ZIP uncompressed size exceeds the safe limit.");
    }
    entries.set(path, content);
  }
  if ([...structure.values()].filter((entry) => !entry.directory).length !== entries.size) {
    throw new Error("ZIP central directory and extracted file inventory differ.");
  }
  return entries;
}
