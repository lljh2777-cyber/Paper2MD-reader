import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import { sha256Bytes } from "../../../packages/after-mineru-contract/src/index";
import type {
  MinerUPdfTextEvidence,
  RepairPdfTextResolver
} from "../../../packages/repair-core/src/index";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REQUEST_ID = /^mineru-text-\d{6}$/;
const MAX_REQUESTS = 64;
const MAX_PAGES = 2_048;
const MAX_TEXT_ITEMS_PER_PAGE = 50_000;
const MAX_PAGE_TEXT_CHARS = 64_000;

export class RepairPdfTextBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairPdfTextBindingError";
  }
}

function checkpoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("After-MinerU PDF text extraction was cancelled");
}

function installPdfJsWorker(): void {
  const scope = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler };
  };
  scope.pdfjsWorker ??= { WorkerMessageHandler };
}

export const resolveRepairPdfText: RepairPdfTextResolver = async (requests, context) => {
  checkpoint(context.signal);
  if (
    !Array.isArray(requests)
    || requests.length > MAX_REQUESTS
    || !SHA256.test(context.pdfSha256)
    || sha256Bytes(context.pdfBytes) !== context.pdfSha256
  ) throw new RepairPdfTextBindingError("PDF text requests are not bound to the selected source PDF");
  if (!requests.length) return [];

  const ids = new Set<string>();
  const pageIndexes = new Set<number>();
  for (const request of requests) {
    if (
      !SAFE_REQUEST_ID.test(request.id)
      || ids.has(request.id)
      || !Number.isSafeInteger(request.pageIndex)
      || request.pageIndex < 0
      || typeof request.sourceText !== "string"
      || !request.sourceText.includes("\uFFFD")
    ) throw new RepairPdfTextBindingError("PDF text request contains an invalid source binding");
    ids.add(request.id);
    pageIndexes.add(request.pageIndex);
  }

  installPdfJsWorker();
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    loadingTask = pdfjs.getDocument({
      data: context.pdfBytes.slice(),
      verbosity: pdfjs.VerbosityLevel.ERRORS
    });
    const document = await loadingTask.promise;
    checkpoint(context.signal);
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PAGES) {
      throw new RepairPdfTextBindingError("Source PDF page count is outside the repair limit");
    }
    const pageText = new Map<number, string>();
    for (const pageIndex of [...pageIndexes].sort((left, right) => left - right)) {
      checkpoint(context.signal);
      if (pageIndex >= document.numPages) {
        throw new RepairPdfTextBindingError("PDF text request references a missing source page");
      }
      const page = await document.getPage(pageIndex + 1);
      try {
        const content = await page.getTextContent();
        checkpoint(context.signal);
        if (!Array.isArray(content.items) || content.items.length > MAX_TEXT_ITEMS_PER_PAGE) continue;
        const parts: string[] = [];
        let length = 0;
        let exceeded = false;
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string" || !item.str) continue;
          length += item.str.length + (parts.length ? 1 : 0);
          if (length > MAX_PAGE_TEXT_CHARS || item.str.includes("\0")) {
            exceeded = true;
            break;
          }
          parts.push(item.str);
        }
        if (!exceeded && parts.length) pageText.set(pageIndex, parts.join(" "));
      } finally {
        page.cleanup();
      }
    }
    const evidence: MinerUPdfTextEvidence[] = [];
    for (const request of requests) {
      const text = pageText.get(request.pageIndex);
      if (text) evidence.push({ candidateId: request.id, pageIndex: request.pageIndex, text });
    }
    return evidence;
  } catch (error) {
    if (context.signal?.aborted || error instanceof RepairPdfTextBindingError) throw error;
    // A missing/corrupt PDF text layer is an expected abstention. Repair still
    // produces a verified package and leaves every unresolved source byte intact.
    return [];
  } finally {
    if (loadingTask) await loadingTask.destroy();
  }
};
