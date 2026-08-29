import { unzipSync } from "fflate";
import { MINERU_PRECISION_PERMISSION_PATTERNS } from "./precision-permissions";

export const MINERU_PRECISION_API_ORIGIN = "https://mineru.net";
export { MINERU_PRECISION_PERMISSION_PATTERNS };

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1_024;
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 384 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const DEFAULT_TIMEOUT_MILLISECONDS = 15 * 60_000;
const DEFAULT_POLL_DELAY_MILLISECONDS = 2_000;
const API_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const UPLOAD_TIMEOUT_MILLISECONDS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 5 * 60_000;
const ALLOWED_OUTPUT = /(?:^|\/)(?:[^/]+\.(?:md|json)|[^/]*(?:origin|layout|spans?)\.pdf|images\/[A-Za-z0-9._/-]+\.(?:bmp|gif|jpe?g|png|webp))$/i;

export type PrecisionProgress =
  | { stage: "allocate"; message: string }
  | { stage: "upload"; message: string }
  | { stage: "extract"; message: string }
  | { stage: "download"; message: string }
  | { stage: "validate"; message: string };

export interface MineruPrecisionResult {
  archive: Uint8Array;
  archiveName: string;
  fileCount: number;
  markdownCount: number;
  jsonCount: number;
  imageCount: number;
}

interface PrecisionOptions {
  fetch?: typeof fetch;
  pollDelayMilliseconds?: number;
  timeoutMilliseconds?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  inspectArchive?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<{
    archive: Uint8Array;
    inspected: Omit<MineruPrecisionResult, "archive" | "archiveName">;
  }>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error(`MinerU 返回了无效的${label}。`);
  }
  return value;
}

export function validateMineruPrecisionToken(value: unknown): string {
  if (typeof value !== "string") throw new Error("MinerU Token 无效。");
  const token = value.trim();
  if (token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new Error("MinerU Token 长度或字符格式无效。");
  }
  return token;
}

export async function validatePrecisionPdf(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".pdf") || file.size < 5 || file.size > MAX_PDF_BYTES) {
    throw new Error("请选择不超过 200MB 的有效 PDF 文件。");
  }
  const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (new TextDecoder("ascii").decode(signature) !== "%PDF-") throw new Error("所选文件不是有效 PDF。");
}

function safeTransferUrl(value: unknown, kind: "upload" | "download"): string {
  if (typeof value !== "string") throw new Error(`MinerU 返回了无效的${kind === "upload" ? "上传" : "下载"}地址。`);
  const url = new URL(value);
  const expectedHost = kind === "upload"
    ? "mineru.oss-cn-shanghai.aliyuncs.com"
    : "cdn-mineru.openxlab.org.cn";
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password || url.hash) {
    throw new Error(`MinerU 返回了未获授权的${kind === "upload" ? "上传" : "下载"}域名；已安全停止。`);
  }
  return url.href;
}

async function boundedBytes(response: Response, maximumBytes: number, label: string, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label}超过安全大小限制。`);
  if (!response.body) throw new Error(`${label}没有响应内容。`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel("request aborted"); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel(`${label}超过安全大小限制。`);
        throw new Error(`${label}超过安全大小限制。`);
      }
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function apiData(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const bytes = await boundedBytes(response, MAX_API_RESPONSE_BYTES, "MinerU API 响应", signal);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("MinerU API 返回了无效 JSON。");
  }
  const root = object(value);
  const code = root?.code;
  if (!response.ok || !root || (typeof code !== "number" && typeof code !== "string") || String(code) !== "0") {
    const message = typeof root?.msg === "string" ? root.msg.slice(0, 512) : `HTTP ${response.status}`;
    throw new Error(`MinerU 未接受请求：${message}`);
  }
  const data = object(root.data);
  if (!data) throw new Error("MinerU API 返回内容不完整。");
  return data;
}

async function fetchWithinDeadline<T>(
  fetcher: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  deadline: number,
  now: () => number,
  maximumMilliseconds: number,
  label: string,
  externalSignal: AbortSignal | undefined,
  consume: (response: Response, signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (externalSignal?.aborted) throw new Error("转换已取消，当前页面中的 Token 引用已清除。");
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("MinerU 精准转换等待超时。");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.min(remaining, maximumMilliseconds)));
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    return await consume(response, controller.signal);
  } catch (error) {
    if (externalSignal?.aborted) throw new Error("转换已取消，当前页面中的 Token 引用已清除。");
    if (timedOut || controller.signal.aborted) throw new Error(`${label}超时，已安全停止。`);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function delayWithSignal(
  delay: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) { await delay(milliseconds); return; }
  if (signal.aborted) throw new Error("转换已取消，当前页面中的 Token 引用已清除。");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      reject(new Error("转换已取消，当前页面中的 Token 引用已清除。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void delay(milliseconds).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function normalizeArchivePath(rawPath: string): string {
  // ZIP entry names are filesystem paths, not URLs. Never trim or URL-decode
  // them: doing so can make a dangerous raw name appear to be an allowed file
  // while the unchanged archive still contains the original name.
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

interface ZipEntryMetadata {
  path: string;
  crc32: number;
  compressedSize: number;
  originalSize: number;
  directory: boolean;
  localOffset: number;
  dataEnd: number;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_value, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

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

function inspectZipStructure(bytes: Uint8Array): Map<string, ZipEntryMetadata> {
  if (bytes.byteLength < 22) throw new Error("MinerU ZIP 结构不完整。");
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

  const metadata = new Map<string, ZipEntryMetadata>();
  const canonicalPaths = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
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
    if (path.split("/").length > 16 || (!directory && !ALLOWED_OUTPUT.test(path))) {
      throw new Error("MinerU ZIP 含不支持的文件。");
    }
    const unixMode = versionMadeBy >>> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error("MinerU ZIP 含不支持的符号链接。");
    if (directory && (compressedSize !== 0 || originalSize !== 0)) throw new Error("MinerU ZIP 目录条目含异常数据。");
    if (!directory && originalSize > 1024 * 1024 && compressedSize > 0 && originalSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new Error("MinerU ZIP 条目压缩比超过安全限制。");
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
      if (descriptorEnds.length !== 1) {
        throw new Error("MinerU ZIP 数据描述符与中央目录冲突。");
      }
      recordEnd = descriptorEnds[0]!;
    } else if (localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localOriginalSize !== originalSize) {
      throw new Error("MinerU ZIP 本地文件头的校验信息冲突。");
    }
    ranges.push({ start: localOffset, end: recordEnd });
    metadata.set(path, { path, crc32: expectedCrc, compressedSize, originalSize, directory, localOffset, dataEnd });
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

export function inspectMineruPrecisionArchive(bytes: Uint8Array): Omit<MineruPrecisionResult, "archive" | "archiveName"> {
  const structure = inspectZipStructure(bytes);
  let entryCount = 0;
  let declaredTotal = 0;
  const seenPaths = new Set<string>();
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_FILES) throw new Error("MinerU ZIP 文件数量超过安全限制。");
      const directory = entry.name.endsWith("/");
      const path = normalizeArchivePath(directory ? entry.name.slice(0, -1) : entry.name);
      const canonicalPath = canonicalArchivePath(path);
      if (seenPaths.has(canonicalPath)) throw new Error("MinerU ZIP 含重复或落盘冲突路径。");
      seenPaths.add(canonicalPath);
      if (directory) return false;
      declaredTotal += entry.originalSize;
      if (entry.originalSize < 1 || entry.originalSize > MAX_ARCHIVE_FILE_BYTES || declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error("MinerU ZIP 解压大小超过安全限制。");
      }
      if (!ALLOWED_OUTPUT.test(path) || path.split("/").length > 16) throw new Error("MinerU ZIP 含不支持的文件。");
      return true;
    }
  });
  const paths = Object.keys(entries).map(normalizeArchivePath);
  if (!paths.length) throw new Error("MinerU ZIP 为空。");
  let actualTotal = 0;
  let markdownCount = 0;
  let jsonCount = 0;
  let stableContentListCount = 0;
  let v2ContentListCount = 0;
  let imageCount = 0;
  for (const [rawPath, content] of Object.entries(entries)) {
    const path = normalizeArchivePath(rawPath);
    const header = structure.get(path);
    if (!header || header.directory || header.originalSize !== content.byteLength || header.crc32 !== crc32(content)) {
      throw new Error("MinerU ZIP 条目的大小或 CRC 校验失败。");
    }
    actualTotal += content.byteLength;
    if (content.byteLength < 1 || content.byteLength > MAX_ARCHIVE_FILE_BYTES || actualTotal > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("MinerU ZIP 解压大小超过安全限制。");
    }
    if (/\.md$/i.test(path)) {
      markdownCount += 1;
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } else if (/\.json$/i.test(path)) {
      jsonCount += 1;
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); }
      catch { throw new Error("MinerU ZIP 含无效 JSON。"); }
      if (/content_list_v2\.json$/i.test(path)) v2ContentListCount += 1;
      else if (/content_list\.json$/i.test(path)) stableContentListCount += 1;
    } else if (/\.(?:bmp|gif|jpe?g|png|webp)$/i.test(path)) imageCount += 1;
  }
  if ([...structure.values()].filter((entry) => !entry.directory).length !== paths.length) {
    throw new Error("MinerU ZIP 文件清单与解压结果不一致。");
  }
  const contentListCount = stableContentListCount + v2ContentListCount;
  const structureIssues: string[] = [];
  if (markdownCount === 0) structureIssues.push("缺少 Markdown");
  else if (markdownCount > 1) structureIssues.push("Markdown 多于 1 个");
  if (contentListCount === 0) structureIssues.push("缺少 content-list JSON");
  if (stableContentListCount > 1 || v2ContentListCount > 1) {
    structureIssues.push("同一版本的 content-list 候选重复");
  }
  if (structureIssues.length) {
    throw new Error(
      `MinerU ZIP 结构不符合预期（${structureIssues.join("；")}）。安全计数：Markdown ${markdownCount}、JSON ${jsonCount}、图片 ${imageCount}、content-list 候选 ${contentListCount}（稳定版 ${stableContentListCount}、v2 ${v2ContentListCount}）。结果未下载。`
    );
  }
  return { fileCount: paths.length, markdownCount, jsonCount, imageCount };
}

function archiveName(filename: string): string {
  const stem = filename.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return `${stem || "mineru-result"}.mineru.zip`;
}

export async function runMineruPrecisionConversion(
  file: File,
  tokenValue: string,
  onProgress: (progress: PrecisionProgress) => void,
  options: PrecisionOptions = {}
): Promise<MineruPrecisionResult> {
  await validatePrecisionPdf(file);
  const token = validateMineruPrecisionToken(tokenValue);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollDelay = options.pollDelayMilliseconds ?? DEFAULT_POLL_DELAY_MILLISECONDS;
  const deadline = now() + (options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);
  const signal = options.signal;
  const apiHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    source: "after-mineru-extension"
  };

  onProgress({ stage: "allocate", message: "正在向 MinerU 申请一次性上传地址…" });
  const allocation = await fetchWithinDeadline(fetcher, `${MINERU_PRECISION_API_ORIGIN}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      files: [{ name: file.name, is_ocr: true }],
      model_version: "vlm",
      language: "en",
      enable_formula: true,
      enable_table: true
    }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer"
  }, deadline, now, API_REQUEST_TIMEOUT_MILLISECONDS, "MinerU 上传地址申请", signal, apiData);
  const batchId = boundedIdentifier(allocation.batch_id, "任务 ID");
  if (!Array.isArray(allocation.file_urls) || allocation.file_urls.length !== 1) throw new Error("MinerU 返回的上传地址数量无效。");
  const uploadUrl = safeTransferUrl(allocation.file_urls[0], "upload");

  onProgress({ stage: "upload", message: "正在把 PDF 直接上传到 MinerU…" });
  // MinerU's pre-signed OSS contract rejects a Content-Type header. Passing the
  // File directly makes Chromium synthesize application/pdf, so send an
  // equivalent Blob with an intentionally empty MIME type instead.
  const uploadBody = file.slice(0, file.size, "");
  const upload = await fetchWithinDeadline(fetcher, uploadUrl, {
    method: "PUT",
    body: uploadBody,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer"
  }, deadline, now, UPLOAD_TIMEOUT_MILLISECONDS, "PDF 上传", signal, async (response) => ({
    ok: response.ok,
    status: response.status
  }));
  if (!upload.ok) throw new Error(`MinerU 上传地址拒绝了 PDF（HTTP ${upload.status}）。`);

  let downloadUrl: string | undefined;
  while (!downloadUrl) {
    if (now() > deadline) throw new Error("MinerU 精准转换等待超时。");
    const data = await fetchWithinDeadline(fetcher, `${MINERU_PRECISION_API_ORIGIN}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
      method: "GET",
      headers: apiHeaders,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer"
    }, deadline, now, API_REQUEST_TIMEOUT_MILLISECONDS, "MinerU 结果轮询", signal, apiData);
    const items = data.extract_result;
    if (!Array.isArray(items) || items.length > 1) throw new Error("MinerU 返回了无效任务结果。");
    const item = object(items[0]);
    const state = typeof item?.state === "string" ? item.state.toLowerCase() : "waiting";
    if (state === "failed") throw new Error(`MinerU 转换失败（${String(item?.err_code ?? "unknown").slice(0, 64)}）。`);
    if (state === "done") downloadUrl = safeTransferUrl(item?.full_zip_url, "download");
    else {
      const progress = object(item?.extract_progress);
      const extracted = Number(progress?.extracted_pages);
      const total = Number(progress?.total_pages);
      const detail = Number.isSafeInteger(extracted) && Number.isSafeInteger(total) && total > 0
        ? `（${extracted}/${total} 页）` : "";
      onProgress({ stage: "extract", message: `MinerU 正在精准转换${detail}…` });
      await delayWithSignal(delay, pollDelay, signal);
    }
  }

  onProgress({ stage: "download", message: "正在下载 MinerU 结果 ZIP…" });
  const archive = await fetchWithinDeadline(fetcher, downloadUrl, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer"
  }, deadline, now, DOWNLOAD_TIMEOUT_MILLISECONDS, "MinerU 结果下载", signal, async (response, requestSignal) => {
    if (!response.ok) throw new Error(`MinerU 结果下载失败（HTTP ${response.status}）。`);
    return boundedBytes(response, MAX_ARCHIVE_BYTES, "MinerU 结果 ZIP", requestSignal);
  });
  onProgress({ stage: "validate", message: "正在校验 Markdown、JSON、图片和 ZIP 路径…" });
  const validated = options.inspectArchive
    ? await options.inspectArchive(archive, signal)
    : { archive, inspected: inspectMineruPrecisionArchive(archive) };
  return { archive: validated.archive, archiveName: archiveName(file.name), ...validated.inspected };
}
