import { createReadStream } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, open } from "node:fs/promises";
import { request, type RequestOptions } from "node:https";
import { basename } from "node:path";
import { assertSafeAcquisitionUrl, isPublicInternetAddress, safeAcquire } from "./safe-acquisition-fetch";

export const MINERU_API_BASE_URL = "https://mineru.net/api/v4";
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULT_ZIP_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const UPLOAD_TIMEOUT_MILLISECONDS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 2 * 60_000;

export type MineruRemoteModel = "vlm" | "pipeline";

export interface MineruRemoteOptions {
  model: MineruRemoteModel;
  language: string;
  ocr: boolean;
  formula: true;
  table: true;
}

export interface MineruBatchItem {
  state: string;
  filename?: string;
  errorCode?: string;
  zipUrl?: string;
  progress?: { extractedPages: number; totalPages: number };
}

export class MineruRemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MineruRemoteError";
  }
}

type MineruTransport = "api" | "upload";

function transportCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const cause = "cause" in error && error.cause && typeof error.cause === "object"
    ? error.cause as Record<string, unknown>
    : error as Record<string, unknown>;
  return typeof cause.code === "string" ? cause.code.toUpperCase() : undefined;
}

function transportErrorName(error: unknown): string | undefined {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined;
}

export function mineruTransportError(transport: MineruTransport, error: unknown): MineruRemoteError {
  if (error instanceof MineruRemoteError) return error;
  const prefix = transport === "api" ? "MINERU_API" : "MINERU_UPLOAD";
  const subject = transport === "api" ? "MinerU submission API" : "MinerU upload destination";
  const code = transportCauseCode(error);
  const name = transportErrorName(error);
  if (code && ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "WSAHOST_NOT_FOUND"].includes(code)) {
    return new MineruRemoteError(`${prefix}_DNS_ERROR`, `Could not resolve the ${subject}; check DNS or network filtering`);
  }
  if (code && (code.includes("CERT") || code.includes("TLS") || code.includes("SSL"))) {
    return new MineruRemoteError(`${prefix}_TLS_ERROR`, `Could not establish a trusted TLS connection to the ${subject}`);
  }
  if (name === "TimeoutError" || (code && ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code))) {
    return new MineruRemoteError(`${prefix}_TIMEOUT`, `Connection to the ${subject} timed out`);
  }
  return new MineruRemoteError(`${prefix}_CONNECTION_FAILED`, `Could not connect to the ${subject}; check the network and try again`);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new MineruRemoteError("INVALID_RESPONSE", `MinerU returned an invalid ${label}`);
  }
  return value;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_API_RESPONSE_BYTES) {
    throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an oversized API response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an oversized API response");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function apiErrorMessage(code: string): string {
  if (["A0202", "A0211"].includes(code)) return "MinerU rejected the saved Token; update it in Settings";
  if (["-60018", "-60019"].includes(code)) return "The MinerU account has insufficient quota for this extraction";
  if (code === "-60005") return "The PDF exceeds MinerU's file-size limit";
  if (code === "-60006") return "The PDF exceeds MinerU's page limit";
  if (code === "-60012") return "MinerU could not find the submitted extraction task";
  return "MinerU could not complete the extraction request";
}

async function parseApiResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await boundedResponseText(response);
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "A0202" : `HTTP_${response.status}`;
    throw new MineruRemoteError(code, apiErrorMessage(code));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned malformed JSON");
  }
  const root = object(value);
  const code = root?.code;
  if (!root || (typeof code !== "number" && typeof code !== "string")) {
    throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an invalid API envelope");
  }
  if (String(code) !== "0") throw new MineruRemoteError(String(code), apiErrorMessage(String(code)));
  const data = object(root.data);
  if (!data) throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned no response data");
  return data;
}

async function publicUploadAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  const answers = await dnsLookup(url.hostname, { all: true, verbatim: true })
    .catch((error) => { throw mineruTransportError("upload", error); });
  if (!answers.length || answers.some((answer) => !isPublicInternetAddress(answer.address))) {
    throw new MineruRemoteError("UNSAFE_UPLOAD_URL", "MinerU returned a non-public upload destination");
  }
  return { address: answers[0]!.address, family: answers[0]!.family as 4 | 6 };
}

async function uploadPdf(urlValue: string, sourcePath: string): Promise<void> {
  const url = assertSafeAcquisitionUrl(urlValue);
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 5 || info.size > MAX_RESULT_ZIP_BYTES) {
    throw new MineruRemoteError("INVALID_SOURCE", "The selected PDF is unavailable or unsafe");
  }
  const signature = Buffer.alloc(5);
  const sourceHandle = await open(sourcePath, "r");
  try {
    await sourceHandle.read(signature, 0, signature.byteLength, 0);
  } finally {
    await sourceHandle.close();
  }
  if (signature.toString("ascii") !== "%PDF-") {
    throw new MineruRemoteError("INVALID_SOURCE", "The selected file is not a PDF");
  }
  const address = await publicUploadAddress(url);
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(sourcePath);
    const handle = request(url, {
      method: "PUT",
      // MinerU's pre-signed upload contract requires a raw PUT without a
      // Content-Type header. Adding one can invalidate the object-store signature.
      ...mineruUploadConnectionOptions(address, info.size),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MILLISECONDS)
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve();
        else reject(new MineruRemoteError("UPLOAD_FAILED", "MinerU's upload destination rejected the PDF"));
      });
      response.once("error", reject);
    });
    handle.setTimeout(UPLOAD_TIMEOUT_MILLISECONDS, () => {
      handle.destroy(new MineruRemoteError("UPLOAD_TIMEOUT", "Uploading the PDF to MinerU timed out"));
    });
    handle.once("error", (error) => {
      source.destroy();
      reject(mineruTransportError("upload", error));
    });
    source.once("error", (error) => {
      const failure = new MineruRemoteError("INVALID_SOURCE", "The selected PDF could not be read safely");
      handle.destroy(failure);
      reject(failure);
    });
    source.pipe(handle);
  });
}

export function mineruUploadHeaders(size: number): Record<string, string> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_RESULT_ZIP_BYTES) {
    throw new MineruRemoteError("INVALID_SOURCE", "The selected PDF size is invalid");
  }
  return { "Content-Length": String(size) };
}

export function mineruUploadConnectionOptions(
  address: { address: string; family: 4 | 6 },
  size: number
): Pick<RequestOptions, "family" | "headers" | "lookup"> & { autoSelectFamily: false } {
  return {
    // Node 20+ enables automatic family selection by default and then invokes
    // custom lookup callbacks with { all: true }. This upload pins one already
    // validated public address, so disable that second lookup mode explicitly.
    autoSelectFamily: false,
    family: address.family,
    headers: mineruUploadHeaders(size),
    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
  };
}

function parseBatchItem(value: unknown): MineruBatchItem {
  const item = object(value);
  if (!item) throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an invalid task result");
  const state = typeof item.state === "string" && /^[a-z_-]{1,64}$/i.test(item.state)
    ? item.state.toLowerCase()
    : "unknown";
  // The batch result contract is keyed by the enclosing batch_id. Unlike the
  // single-task endpoint, extract_result entries do not contain task_id.
  const result: MineruBatchItem = { state };
  if (typeof item.file_name === "string") result.filename = basename(item.file_name).slice(0, 512);
  if (item.err_code !== undefined && item.err_code !== null) result.errorCode = String(item.err_code).slice(0, 64);
  if (typeof item.full_zip_url === "string") result.zipUrl = assertSafeAcquisitionUrl(item.full_zip_url).href;
  const progress = object(item.extract_progress);
  if (progress) {
    const extractedPages = Number(progress.extracted_pages);
    const totalPages = Number(progress.total_pages);
    if (Number.isSafeInteger(extractedPages) && Number.isSafeInteger(totalPages)
      && extractedPages >= 0 && totalPages >= extractedPages && totalPages <= 10_000) {
      result.progress = { extractedPages, totalPages };
    }
  }
  return result;
}

export class MineruPrecisionApiClient {
  constructor(private readonly token: string, private readonly baseUrl = MINERU_API_BASE_URL) {
    if (token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
      throw new MineruRemoteError("INVALID_TOKEN", "The saved MinerU Token is invalid");
    }
    if (baseUrl !== MINERU_API_BASE_URL) throw new Error("The desktop MinerU endpoint is fixed");
  }

  private async api(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        source: "paper2md-desktop",
        ...init.headers
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    }).catch((error) => { throw mineruTransportError("api", error); });
    return parseApiResponse(response);
  }

  async submitPdf(
    sourcePath: string,
    filename: string,
    options: MineruRemoteOptions,
    onUploadAllocated: () => void = () => undefined
  ): Promise<string> {
    const safeName = basename(filename).slice(0, 240);
    if (!safeName.toLowerCase().endsWith(".pdf")) throw new MineruRemoteError("INVALID_SOURCE", "Only PDF files can be submitted");
    const data = await this.api("/file-urls/batch", {
      method: "POST",
      body: JSON.stringify({
        files: [{ name: safeName, is_ocr: options.ocr }],
        model_version: options.model,
        language: options.language,
        enable_formula: options.formula,
        enable_table: options.table
      })
    });
    const batchId = boundedIdentifier(data.batch_id, "batch ID");
    if (!Array.isArray(data.file_urls) || data.file_urls.length !== 1 || typeof data.file_urls[0] !== "string") {
      throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an invalid upload allocation");
    }
    onUploadAllocated();
    await uploadPdf(data.file_urls[0], sourcePath);
    return batchId;
  }

  async getBatch(batchId: string): Promise<MineruBatchItem[]> {
    const id = boundedIdentifier(batchId, "batch ID");
    const data = await this.api(`/extract-results/batch/${encodeURIComponent(id)}`, { method: "GET" });
    const items = data.extract_result;
    if (!Array.isArray(items) || items.length > 1) {
      throw new MineruRemoteError("INVALID_RESPONSE", "MinerU returned an invalid batch result");
    }
    return items.map(parseBatchItem);
  }

  async download(zipUrl: string): Promise<Uint8Array> {
    const response = await safeAcquire(zipUrl, {
      accept: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      maximumBytes: MAX_RESULT_ZIP_BYTES,
      timeoutMilliseconds: DOWNLOAD_TIMEOUT_MILLISECONDS
    });
    return response.bytes;
  }
}
