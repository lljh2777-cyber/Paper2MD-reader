import {
  extractValidatedZipEntries as extractSafeZipEntries,
  type SafeZipArchiveLimits
} from "../../packages/after-mineru-contract/src/index";

export interface MinerUArchiveLimits extends SafeZipArchiveLimits {}

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

interface ParsedMinerUArchive extends MinerUArchiveInspection {
  entries: Map<string, Uint8Array>;
  stableContentLists: string[];
  v2ContentLists: string[];
  markdownPaths: string[];
}

function canonicalArchivePath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

/**
 * Extract a ZIP only after checking its complete central/local-header layout,
 * path collisions, compression ratios, uncompressed limits, and per-entry
 * CRC. Callers supply the format-specific path allowlist.
 */
export function extractValidatedZipEntries(
  bytes: Uint8Array,
  limits: Readonly<MinerUArchiveLimits>,
  allowedPath: (path: string) => boolean
): Map<string, Uint8Array> {
  return extractSafeZipEntries(bytes, limits, allowedPath);
}

function parseMinerUArchive(bytes: Uint8Array, limits: Readonly<MinerUArchiveLimits>): ParsedMinerUArchive {
  const normalizedEntries = extractValidatedZipEntries(bytes, limits, (path) => ALLOWED_OUTPUT.test(path));
  const paths = [...normalizedEntries.keys()];
  if (!paths.length) throw new Error("MinerU ZIP 为空。");
  let markdownCount = 0;
  let jsonCount = 0;
  let imageCount = 0;
  const markdownPaths: string[] = [];
  const stableContentLists: string[] = [];
  const v2ContentLists: string[] = [];
  for (const [path, content] of normalizedEntries) {
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
