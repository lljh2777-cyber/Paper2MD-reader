import {
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_LIMITS,
  isSafeAfterMinerUPath
} from "../../../packages/after-mineru-contract/src/index";

export const AFTER_MINERU_PREVIEW_WORKER_PROTOCOL = "after-mineru-preview-import-worker-v1" as const;
export const AFTER_MINERU_PREVIEW_TOTAL_BYTES = 256 * 1024 * 1024;

export const AFTER_MINERU_PREVIEW_WORKER_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  totalBytes: AFTER_MINERU_PREVIEW_TOTAL_BYTES,
  timeoutMs: 60_000
});

export interface AfterMinerUPreviewWorkerStart {
  protocol: typeof AFTER_MINERU_PREVIEW_WORKER_PROTOCOL;
  type: "start";
  requestId: string;
  archiveBytes: ArrayBuffer;
  expectedFileCount: number;
}

export interface AfterMinerUPreviewTransferEntry {
  path: string;
  data: ArrayBuffer;
}

export interface AfterMinerUPreviewWorkerSuccess {
  protocol: typeof AFTER_MINERU_PREVIEW_WORKER_PROTOCOL;
  type: "success";
  requestId: string;
  fileCount: number;
  entries: AfterMinerUPreviewTransferEntry[];
}

export interface AfterMinerUPreviewWorkerFailure {
  protocol: typeof AFTER_MINERU_PREVIEW_WORKER_PROTOCOL;
  type: "error";
  requestId: string;
  error: string;
}

export type AfterMinerUPreviewWorkerResponse =
  | AfterMinerUPreviewWorkerSuccess
  | AfterMinerUPreviewWorkerFailure;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validFileCount(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) > 0
    && Number(value) <= AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount;
}

export function isAfterMinerUPreviewWorkerStart(value: unknown): value is AfterMinerUPreviewWorkerStart {
  const message = record(value);
  return Boolean(message)
    && exactKeys(message!, ["protocol", "type", "requestId", "archiveBytes", "expectedFileCount"])
    && message!.protocol === AFTER_MINERU_PREVIEW_WORKER_PROTOCOL
    && message!.type === "start"
    && validRequestId(message!.requestId)
    && message!.archiveBytes instanceof ArrayBuffer
    && message!.archiveBytes.byteLength >= 22
    && message!.archiveBytes.byteLength <= AFTER_MINERU_PREVIEW_WORKER_LIMITS.archiveBytes
    && validFileCount(message!.expectedFileCount);
}

export function hasAfterMinerUPreviewWorkerEnvelope(value: unknown, requestId: string): boolean {
  const message = record(value);
  return message?.protocol === AFTER_MINERU_PREVIEW_WORKER_PROTOCOL
    && message.requestId === requestId;
}

function validEntries(value: unknown, expectedFileCount: number): value is AfterMinerUPreviewTransferEntry[] {
  if (!Array.isArray(value) || value.length !== expectedFileCount) return false;
  const canonicalPaths = new Set<string>();
  let totalBytes = 0;
  let hasManifest = false;
  for (const candidate of value) {
    const entry = record(candidate);
    if (!entry || !exactKeys(entry, ["path", "data"])) return false;
    if (typeof entry.path !== "string" || !isSafeAfterMinerUPath(entry.path)) return false;
    const canonical = entry.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (canonicalPaths.has(canonical)) return false;
    canonicalPaths.add(canonical);
    if (!(entry.data instanceof ArrayBuffer)
      || entry.data.byteLength < 1
      || entry.data.byteLength > AFTER_MINERU_PACKAGE_LIMITS.fileBytes) return false;
    totalBytes += entry.data.byteLength;
    if (totalBytes > AFTER_MINERU_PREVIEW_TOTAL_BYTES) return false;
    if (entry.path === AFTER_MINERU_MANIFEST_PATH) hasManifest = true;
  }
  return hasManifest;
}

export function isAfterMinerUPreviewWorkerResponse(
  value: unknown,
  requestId: string
): value is AfterMinerUPreviewWorkerResponse {
  const message = record(value);
  if (!message || !hasAfterMinerUPreviewWorkerEnvelope(message, requestId)) return false;
  if (message.type === "error") {
    return exactKeys(message, ["protocol", "type", "requestId", "error"])
      && typeof message.error === "string"
      && message.error.length > 0
      && message.error.length <= 2_000;
  }
  if (message.type !== "success"
    || !exactKeys(message, ["protocol", "type", "requestId", "fileCount", "entries"])
    || !validFileCount(message.fileCount)) return false;
  return validEntries(message.entries, message.fileCount);
}
