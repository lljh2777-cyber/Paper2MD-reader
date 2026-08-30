import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";
import { AFTER_MINERU_PACKAGE_LIMITS } from "../../../packages/after-mineru-contract/src/index";
import { afterMinerUArchiveRootLabel } from "./after-mineru-archive-import";
import {
  AFTER_MINERU_PREVIEW_WORKER_LIMITS,
  AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
  hasAfterMinerUPreviewWorkerEnvelope,
  isAfterMinerUPreviewWorkerResponse,
  type AfterMinerUPreviewWorkerStart
} from "./after-mineru-preview-worker-protocol";

let requestSequence = 0;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
  zip: "application/zip"
});

function mimeType(path: string): string {
  return MIME_BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function nextRequestId(): string {
  requestSequence += 1;
  return `after-mineru-preview-${requestSequence}`;
}

export class AfterMinerUPreviewImportCancelledError extends Error {
  constructor() {
    super("Reader preview validation was cancelled.");
    this.name = "AfterMinerUPreviewImportCancelledError";
  }
}

export interface AfterMinerUPreviewWorkerImportOptions {
  expectedFileCount: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Number(value)
    : AFTER_MINERU_PREVIEW_WORKER_LIMITS.timeoutMs;
}

export async function importAfterMinerUPreviewWithWorker(
  archiveBytes: ArrayBuffer,
  archiveName: string,
  options: AfterMinerUPreviewWorkerImportOptions
): Promise<BrowserDirectoryReaderFileSystem> {
  if (options.signal?.aborted) throw new AfterMinerUPreviewImportCancelledError();
  if (!(archiveBytes instanceof ArrayBuffer)
    || archiveBytes.byteLength < 22
    || archiveBytes.byteLength > AFTER_MINERU_PREVIEW_WORKER_LIMITS.archiveBytes) {
    throw new Error("The After-MinerU preview archive is outside the safe compressed-size limit.");
  }
  if (!Number.isSafeInteger(options.expectedFileCount)
    || options.expectedFileCount < 1
    || options.expectedFileCount > AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount) {
    throw new Error("The declared After-MinerU file count is invalid.");
  }
  const requestId = nextRequestId();
  const worker = new Worker(new URL("./after-mineru-preview-worker.ts", import.meta.url), { type: "module" });
  const request: AfterMinerUPreviewWorkerStart = {
    protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
    type: "start",
    requestId,
    archiveBytes,
    expectedFileCount: options.expectedFileCount
  };

  return await new Promise<BrowserDirectoryReaderFileSystem>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = (): void => finish(() => reject(new AfterMinerUPreviewImportCancelledError()));
    timer = setTimeout(() => {
      finish(() => reject(new Error("Reader preview validation timed out; no package was loaded.")));
    }, positiveTimeout(options.timeoutMs));
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", () => {
      finish(() => reject(new Error("Reader preview validation Worker failed to start.")));
    }, { once: true });
    worker.addEventListener("messageerror", () => {
      finish(() => reject(new Error("Reader preview validation Worker returned unreadable data.")));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (settled) return;
      if (!hasAfterMinerUPreviewWorkerEnvelope(event.data, requestId)) return;
      if (!isAfterMinerUPreviewWorkerResponse(event.data, requestId)) {
        finish(() => reject(new Error("Reader preview validation Worker returned an invalid response.")));
        return;
      }
      const response = event.data;
      if (response.type === "error") {
        finish(() => reject(new Error(response.error)));
        return;
      }
      if (response.fileCount !== options.expectedFileCount) {
        finish(() => reject(new Error("Reader preview Worker file count does not match the handoff.")));
        return;
      }
      try {
        const files = new Map(response.entries.map((entry) => [
          entry.path,
          new File([entry.data], entry.path.split("/").pop() ?? entry.path, { type: mimeType(entry.path) })
        ]));
        const fileSystem = BrowserDirectoryReaderFileSystem.fromAfterMinerUArchive(
          afterMinerUArchiveRootLabel(archiveName),
          files
        );
        finish(() => resolve(fileSystem));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage(request, [archiveBytes]);
    } catch (error) {
      finish(() => reject(new Error(error instanceof Error
        ? `Reader preview Worker could not receive the archive: ${error.message}`
        : "Reader preview Worker could not receive the archive.")));
    }
  });
}
