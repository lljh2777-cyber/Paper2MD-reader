import { MINERU_PRECISION_PERMISSION_PATTERNS } from "./precision-permissions";
import {
  inspectMinerUArchive,
  MINERU_ARCHIVE_TRANSPORT_LIMITS
} from "../../../src/model/mineru-archive";

export const MINERU_PRECISION_API_ORIGIN = "https://mineru.net";
export { MINERU_PRECISION_PERMISSION_PATTERNS };

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MINERU_ARCHIVE_TRANSPORT_LIMITS.archiveBytes;
const DEFAULT_TIMEOUT_MILLISECONDS = 15 * 60_000;
const DEFAULT_POLL_DELAY_MILLISECONDS = 2_000;
const API_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const UPLOAD_TIMEOUT_MILLISECONDS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 5 * 60_000;

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

export function inspectMineruPrecisionArchive(bytes: Uint8Array): Omit<MineruPrecisionResult, "archive" | "archiveName"> {
  return inspectMinerUArchive(bytes, MINERU_ARCHIVE_TRANSPORT_LIMITS);
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
