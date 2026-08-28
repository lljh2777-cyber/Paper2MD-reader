import { unzipSync } from "fflate";

export const MINERU_PRECISION_API_ORIGIN = "https://mineru.net";
export const MINERU_PRECISION_PERMISSION_PATTERNS = [
  "https://mineru.net/*",
  "https://mineru.oss-cn-shanghai.aliyuncs.com/*",
  "https://cdn-mineru.openxlab.org.cn/*"
] as const;

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1_024;
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 15 * 60_000;
const DEFAULT_POLL_DELAY_MILLISECONDS = 2_000;
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
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.username || url.password || url.hash) {
    throw new Error(`MinerU 返回了未获授权的${kind === "upload" ? "上传" : "下载"}域名；已安全停止。`);
  }
  return url.href;
}

async function boundedBytes(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label}超过安全大小限制。`);
  if (!response.body) throw new Error(`${label}没有响应内容。`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
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

async function apiData(response: Response): Promise<Record<string, unknown>> {
  const bytes = await boundedBytes(response, MAX_API_RESPONSE_BYTES, "MinerU API 响应");
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

function normalizeArchivePath(rawPath: string): string {
  let decoded = rawPath.trim();
  try { decoded = decodeURIComponent(decoded); }
  catch { throw new Error("MinerU ZIP 含无效路径编码。"); }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/, 1)[0];
  const segments = normalized.split("/");
  if (!normalized || normalized.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("MinerU ZIP 含不安全路径。");
  }
  return segments.join("/");
}

export function inspectMineruPrecisionArchive(bytes: Uint8Array): Omit<MineruPrecisionResult, "archive" | "archiveName"> {
  let entryCount = 0;
  let declaredTotal = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_FILES) throw new Error("MinerU ZIP 文件数量超过安全限制。");
      if (entry.name.endsWith("/")) return false;
      declaredTotal += entry.originalSize;
      if (entry.originalSize < 1 || entry.originalSize > MAX_ARCHIVE_FILE_BYTES || declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error("MinerU ZIP 解压大小超过安全限制。");
      }
      const path = normalizeArchivePath(entry.name);
      if (!ALLOWED_OUTPUT.test(path) || path.split("/").length > 16) throw new Error("MinerU ZIP 含不支持的文件。");
      return true;
    }
  });
  const paths = Object.keys(entries).map(normalizeArchivePath);
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error("MinerU ZIP 为空或含重复路径。");
  let actualTotal = 0;
  let markdownCount = 0;
  let jsonCount = 0;
  let stableContentListCount = 0;
  let v2ContentListCount = 0;
  let imageCount = 0;
  for (const [rawPath, content] of Object.entries(entries)) {
    const path = normalizeArchivePath(rawPath);
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
  if (markdownCount !== 1 || stableContentListCount > 1 || v2ContentListCount > 1
    || stableContentListCount + v2ContentListCount < 1) {
    throw new Error("MinerU ZIP 必须包含唯一 Markdown 和明确的 content-list JSON。");
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
  const apiHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    source: "after-mineru-extension"
  };

  onProgress({ stage: "allocate", message: "正在向 MinerU 申请一次性上传地址…" });
  const allocation = await apiData(await fetcher(`${MINERU_PRECISION_API_ORIGIN}/api/v4/file-urls/batch`, {
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
  }));
  const batchId = boundedIdentifier(allocation.batch_id, "任务 ID");
  if (!Array.isArray(allocation.file_urls) || allocation.file_urls.length !== 1) throw new Error("MinerU 返回的上传地址数量无效。");
  const uploadUrl = safeTransferUrl(allocation.file_urls[0], "upload");

  onProgress({ stage: "upload", message: "正在把 PDF 直接上传到 MinerU…" });
  // MinerU's pre-signed OSS contract rejects a Content-Type header. Passing the
  // File directly makes Chromium synthesize application/pdf, so send an
  // equivalent Blob with an intentionally empty MIME type instead.
  const uploadBody = file.slice(0, file.size, "");
  const upload = await fetcher(uploadUrl, {
    method: "PUT",
    body: uploadBody,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer"
  });
  if (!upload.ok) throw new Error(`MinerU 上传地址拒绝了 PDF（HTTP ${upload.status}）。`);

  let downloadUrl: string | undefined;
  while (!downloadUrl) {
    if (now() > deadline) throw new Error("MinerU 精准转换等待超时。");
    const data = await apiData(await fetcher(`${MINERU_PRECISION_API_ORIGIN}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
      method: "GET",
      headers: apiHeaders,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer"
    }));
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
      await delay(pollDelay);
    }
  }

  onProgress({ stage: "download", message: "正在下载 MinerU 结果 ZIP…" });
  const response = await fetcher(downloadUrl, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error(`MinerU 结果下载失败（HTTP ${response.status}）。`);
  const archive = await boundedBytes(response, MAX_ARCHIVE_BYTES, "MinerU 结果 ZIP");
  onProgress({ stage: "validate", message: "正在校验 Markdown、JSON、图片和 ZIP 路径…" });
  const inspected = inspectMineruPrecisionArchive(archive);
  return { archive, archiveName: archiveName(file.name), ...inspected };
}
