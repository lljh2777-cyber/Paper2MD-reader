import { unzipSync } from "fflate";

export interface MinerUArchiveLimits {
  archiveBytes: number;
  fileCount: number;
  fileBytes: number;
  totalBytes: number;
  compressionRatio: number;
  pathDepth: number;
}

export const MINERU_ARCHIVE_TRANSPORT_LIMITS: Readonly<MinerUArchiveLimits> = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  fileCount: 1_024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 384 * 1024 * 1024,
  compressionRatio: 200,
  pathDepth: 16
});

export const MINERU_ARCHIVE_READER_LIMITS: Readonly<MinerUArchiveLimits> = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  fileCount: 512,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  compressionRatio: 200,
  pathDepth: 16
});

export interface MinerUArchiveInspection {
  fileCount: number;
  markdownCount: number;
  jsonCount: number;
  imageCount: number;
}

export interface MinerUArchiveReaderExtraction extends MinerUArchiveInspection {
  files: ReadonlyMap<string, Uint8Array>;
  rootPrefix: string;
  articlePath: string;
  contentListPath: string;
}

const ALLOWED_OUTPUT = /(?:^|\/)(?:[^/]+\.(?:md|json)|[^/]*(?:origin|layout|spans?)\.pdf|images\/[A-Za-z0-9._/-]+\.(?:bmp|gif|jpe?g|png|webp))$/i;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
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

interface ParsedMinerUArchive extends MinerUArchiveInspection {
  entries: Map<string, Uint8Array>;
  stableContentLists: string[];
  v2ContentLists: string[];
  markdownPaths: string[];
}

function normalizeArchivePath(rawPath: string): string {
  // ZIP entry names are filesystem paths, not URLs. Never trim or URL-decode
  // them: doing so can make a dangerous raw name appear to be an allowed file
  // while the unchanged source archive still contains the original name.
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || rawPath !== rawPath.trim() || normalized.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("MinerU ZIP 含不安全路径。");
  }
  if (normalized.length > 1024 || segments.some((segment) => segment.length > 255
    || /[\u0000-\u001f<>:"|?*#]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))) {
    throw new Error("MinerU ZIP 含不兼容本地文件系统的路径。");
  }
  return segments.map((segment) => segment.normalize("NFC")).join("/");
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
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new Error("MinerU ZIP 含未声明 UTF-8 的文件名。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("MinerU ZIP 含无效 UTF-8 文件名。"); }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function inspectZipStructure(bytes: Uint8Array, limits: Readonly<MinerUArchiveLimits>): Map<string, ZipEntryMetadata> {
  if (bytes.byteLength < 22) throw new Error("MinerU ZIP 结构不完整。");
  if (bytes.byteLength > limits.archiveBytes) throw new Error("MinerU ZIP 超过当前安全大小限制。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliestEnd = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= earliestEnd; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("MinerU ZIP 缺少有效中央目录。");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk || centralDisk || diskEntries !== totalEntries || totalEntries === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== endOffset) {
    throw new Error("MinerU ZIP 使用了不支持的分卷、ZIP64 或中央目录结构。");
  }
  if (totalEntries > limits.fileCount) throw new Error("MinerU ZIP 文件数量超过安全限制。");

  const metadata = new Map<string, ZipEntryMetadata>();
  const canonicalPaths = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let declaredTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) {
      throw new Error("MinerU ZIP 中央目录条目无效。");
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
    if (!nameLength || nextOffset > endOffset || compressedSize === 0xffffffff || originalSize === 0xffffffff
      || localOffset === 0xffffffff || diskStart !== 0 || (flags & 0x2061) !== 0 || (method !== 0 && method !== 8)) {
      throw new Error("MinerU ZIP 含加密、不支持或超出 ZIP32 边界的条目。");
    }
    const centralName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeZipName(centralName, Boolean(flags & 0x800));
    const directory = rawName.endsWith("/");
    const path = normalizeArchivePath(directory ? rawName.slice(0, -1) : rawName);
    const canonicalPath = canonicalArchivePath(path);
    if (metadata.has(path) || canonicalPaths.has(canonicalPath)) throw new Error("MinerU ZIP 含重复或落盘冲突路径。");
    canonicalPaths.add(canonicalPath);
    if (path.split("/").length > limits.pathDepth || (!directory && !ALLOWED_OUTPUT.test(path))) {
      throw new Error("MinerU ZIP 含不支持的文件。");
    }
    const unixMode = versionMadeBy >>> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error("MinerU ZIP 含不支持的符号链接。");
    if (directory && (compressedSize !== 0 || originalSize !== 0)) throw new Error("MinerU ZIP 目录条目含异常数据。");
    if (!directory) {
      declaredTotal += originalSize;
      if (originalSize < 1 || originalSize > limits.fileBytes || declaredTotal > limits.totalBytes) {
        throw new Error("MinerU ZIP 解压大小超过安全限制。");
      }
      if (originalSize > 1024 * 1024 && compressedSize > 0 && originalSize / compressedSize > limits.compressionRatio) {
        throw new Error("MinerU ZIP 条目压缩比超过安全限制。");
      }
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER) {
      throw new Error("MinerU ZIP 本地文件头无效。");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset
      || !sameBytes(centralName, bytes.subarray(localNameStart, localNameStart + localNameLength))) {
      throw new Error("MinerU ZIP 本地文件头与中央目录冲突。");
    }
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localOriginalSize = view.getUint32(localOffset + 22, true);
    let recordEnd = dataEnd;
    if (flags & 0x08) {
      if ((localCrc !== 0 && localCrc !== expectedCrc)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localOriginalSize !== 0 && localOriginalSize !== originalSize)
        || dataEnd + 12 > centralOffset) {
        throw new Error("MinerU ZIP 本地文件头的校验信息冲突。");
      }
      const descriptorEnds: number[] = [];
      if (dataEnd + 12 <= centralOffset
        && view.getUint32(dataEnd, true) === expectedCrc
        && view.getUint32(dataEnd + 4, true) === compressedSize
        && view.getUint32(dataEnd + 8, true) === originalSize) {
        descriptorEnds.push(dataEnd + 12);
      }
      if (dataEnd + 16 <= centralOffset
        && view.getUint32(dataEnd, true) === 0x08074b50
        && view.getUint32(dataEnd + 4, true) === expectedCrc
        && view.getUint32(dataEnd + 8, true) === compressedSize
        && view.getUint32(dataEnd + 12, true) === originalSize) {
        descriptorEnds.push(dataEnd + 16);
      }
      if (descriptorEnds.length !== 1) throw new Error("MinerU ZIP 数据描述符与中央目录冲突。");
      recordEnd = descriptorEnds[0]!;
    } else if (localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localOriginalSize !== originalSize) {
      throw new Error("MinerU ZIP 本地文件头的校验信息冲突。");
    }
    ranges.push({ start: localOffset, end: recordEnd });
    metadata.set(path, { path, crc32: expectedCrc, compressedSize, originalSize, directory });
    offset = nextOffset;
  }
  if (offset !== endOffset) throw new Error("MinerU ZIP 中央目录长度不一致。");
  ranges.sort((left, right) => left.start - right.start);
  if (ranges[0]?.start !== 0 || ranges[ranges.length - 1]?.end !== centralOffset) {
    throw new Error("MinerU ZIP 本地记录区含未登记数据。");
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start !== ranges[index - 1]!.end) {
      throw new Error(ranges[index]!.start < ranges[index - 1]!.end
        ? "MinerU ZIP 条目数据发生重叠。"
        : "MinerU ZIP 本地记录区含未登记数据。");
    }
  }
  return metadata;
}

function parseMinerUArchive(bytes: Uint8Array, limits: Readonly<MinerUArchiveLimits>): ParsedMinerUArchive {
  const structure = inspectZipStructure(bytes, limits);
  const seenPaths = new Set<string>();
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const directory = entry.name.endsWith("/");
      const path = normalizeArchivePath(directory ? entry.name.slice(0, -1) : entry.name);
      const canonicalPath = canonicalArchivePath(path);
      if (seenPaths.has(canonicalPath)) throw new Error("MinerU ZIP 含重复或落盘冲突路径。");
      seenPaths.add(canonicalPath);
      return !directory;
    }
  });
  const paths = Object.keys(entries).map(normalizeArchivePath);
  if (!paths.length) throw new Error("MinerU ZIP 为空。");
  let actualTotal = 0;
  let markdownCount = 0;
  let jsonCount = 0;
  let imageCount = 0;
  const markdownPaths: string[] = [];
  const stableContentLists: string[] = [];
  const v2ContentLists: string[] = [];
  const normalizedEntries = new Map<string, Uint8Array>();
  for (const [rawPath, content] of Object.entries(entries)) {
    const path = normalizeArchivePath(rawPath);
    const header = structure.get(path);
    if (!header || header.directory || header.originalSize !== content.byteLength || header.crc32 !== crc32(content)) {
      throw new Error("MinerU ZIP 条目的大小或 CRC 校验失败。");
    }
    actualTotal += content.byteLength;
    if (content.byteLength < 1 || content.byteLength > limits.fileBytes || actualTotal > limits.totalBytes) {
      throw new Error("MinerU ZIP 解压大小超过安全限制。");
    }
    if (/\.md$/i.test(path)) {
      markdownCount += 1;
      markdownPaths.push(path);
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } else if (/\.json$/i.test(path)) {
      jsonCount += 1;
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); }
      catch { throw new Error("MinerU ZIP 含无效 JSON。"); }
      if (/content_list_v2\.json$/i.test(path)) v2ContentLists.push(path);
      else if (/content_list\.json$/i.test(path)) stableContentLists.push(path);
    } else if (/\.(?:bmp|gif|jpe?g|png|webp)$/i.test(path)) imageCount += 1;
    normalizedEntries.set(path, content);
  }
  if ([...structure.values()].filter((entry) => !entry.directory).length !== paths.length) {
    throw new Error("MinerU ZIP 文件清单与解压结果不一致。");
  }
  const contentListCount = stableContentLists.length + v2ContentLists.length;
  const structureIssues: string[] = [];
  if (markdownCount === 0) structureIssues.push("缺少 Markdown");
  else if (markdownCount > 1) structureIssues.push("Markdown 多于 1 个");
  if (contentListCount === 0) structureIssues.push("缺少 content-list JSON");
  if (stableContentLists.length > 1 || v2ContentLists.length > 1) {
    structureIssues.push("同一版本的 content-list 候选重复");
  }
  if (structureIssues.length) {
    throw new Error(
      `MinerU ZIP 结构不符合预期（${structureIssues.join("；")}）。安全计数：Markdown ${markdownCount}、JSON ${jsonCount}、图片 ${imageCount}、content-list 候选 ${contentListCount}（稳定版 ${stableContentLists.length}、v2 ${v2ContentLists.length}）。结果未下载。`
    );
  }
  return {
    entries: normalizedEntries,
    markdownPaths,
    stableContentLists,
    v2ContentLists,
    fileCount: paths.length,
    markdownCount,
    jsonCount,
    imageCount
  };
}

export function inspectMinerUArchive(
  bytes: Uint8Array,
  limits: Readonly<MinerUArchiveLimits> = MINERU_ARCHIVE_TRANSPORT_LIMITS
): MinerUArchiveInspection {
  const parsed = parseMinerUArchive(bytes, limits);
  return {
    fileCount: parsed.fileCount,
    markdownCount: parsed.markdownCount,
    jsonCount: parsed.jsonCount,
    imageCount: parsed.imageCount
  };
}

export function extractMinerUArchiveForReader(
  bytes: Uint8Array,
  limits: Readonly<MinerUArchiveLimits> = MINERU_ARCHIVE_READER_LIMITS
): MinerUArchiveReaderExtraction {
  const parsed = parseMinerUArchive(bytes, limits);
  const sourceArticlePath = parsed.markdownPaths[0]!;
  const sourceContentListPath = (parsed.stableContentLists[0] ?? parsed.v2ContentLists[0])!;
  const articleSlash = sourceArticlePath.lastIndexOf("/");
  const contentListSlash = sourceContentListPath.lastIndexOf("/");
  const rootPrefix = articleSlash >= 0 ? sourceArticlePath.slice(0, articleSlash + 1) : "";
  if (contentListSlash !== articleSlash
    || !sourceContentListPath.startsWith(rootPrefix)
    || [...parsed.entries.keys()].some((path) => rootPrefix && !path.startsWith(rootPrefix))) {
    throw new Error("MinerU ZIP 无法确定唯一论文根目录；已安全停止。");
  }
  const files = new Map<string, Uint8Array>();
  const canonicalPaths = new Set<string>();
  for (const [sourcePath, content] of parsed.entries) {
    const readerPath = rootPrefix ? sourcePath.slice(rootPrefix.length) : sourcePath;
    const canonicalPath = canonicalArchivePath(readerPath);
    if (!readerPath || canonicalPaths.has(canonicalPath)) throw new Error("MinerU ZIP 的 Reader 投影含路径冲突。");
    canonicalPaths.add(canonicalPath);
    files.set(readerPath, content);
  }
  return {
    files,
    rootPrefix,
    articlePath: rootPrefix ? sourceArticlePath.slice(rootPrefix.length) : sourceArticlePath,
    contentListPath: rootPrefix ? sourceContentListPath.slice(rootPrefix.length) : sourceContentListPath,
    fileCount: parsed.fileCount,
    markdownCount: parsed.markdownCount,
    jsonCount: parsed.jsonCount,
    imageCount: parsed.imageCount
  };
}
