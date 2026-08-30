import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";
import { ReaderPackagePicker } from "../../../packages/reader-core/src/index";
import type { ReaderPdfDocumentSelection, ReaderProcessingProgress } from "../../../packages/reader-core/src/index";
import { configuredProcessingApiBaseUrl, ProcessingClient } from "./processing-client";
import {
  assertClippingArchiveByteLength,
  clippingArchiveRootLabel,
  extractClippingArchiveBytes
} from "../../../src/model/clipping-archive";
import { processBrowserPdf } from "./browser-pdf-processor";
import { importMinerUArchiveFile, mineruArchiveRootLabel } from "./mineru-archive-import";
import { importAfterMinerUArchiveFile } from "./after-mineru-archive-import";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

export interface BrowserPackagePickerOptions {
  /** Whether PDF projection may use the configured processing API. */
  enableProcessingApi?: boolean;
  /**
   * Whether this picker may turn a selected PDF into a generated Markdown
   * package. Disable this for Reader entry points that only import existing
   * PDF, Markdown, MinerU, or Paper2MD artifacts.
   */
  allowPdfProjection?: boolean;
  /**
   * Whether this picker may open a PDF as an ephemeral, read-only document.
   * This capability never runs extraction or creates a Markdown package.
   */
  allowDirectPdfOpen?: boolean;
}

export const DIRECT_PDF_PATH = "_reader/source.pdf";
export const MIN_DIRECT_PDF_BYTES = 5;
export const MAX_DIRECT_PDF_BYTES = 64 * 1024 * 1024;

export function assertDirectPdfByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < MIN_DIRECT_PDF_BYTES || byteLength > MAX_DIRECT_PDF_BYTES) {
    throw new Error("PDF files opened directly must be between 5 bytes and 64 MB.");
  }
}

export async function createDirectPdfDocument(file: File): Promise<ReaderPdfDocumentSelection> {
  assertDirectPdfByteLength(file.size);
  const header = new Uint8Array(await file.slice(0, MIN_DIRECT_PDF_BYTES).arrayBuffer());
  if (
    header.length !== MIN_DIRECT_PDF_BYTES
    || header[0] !== 0x25
    || header[1] !== 0x50
    || header[2] !== 0x44
    || header[3] !== 0x46
    || header[4] !== 0x2d
  ) {
    throw new Error("The selected file is not a PDF: the %PDF- header is missing.");
  }
  const label = file.name.trim().slice(0, 500) || "PDF document";
  return {
    fileSystem: BrowserDirectoryReaderFileSystem.fromFileMap(label, new Map([[DIRECT_PDF_PATH, file]])),
    pdfPath: DIRECT_PDF_PATH,
    label
  };
}

export class BrowserPackagePicker implements ReaderPackagePicker {
  readonly platform = "web" as const;
  private readonly input: HTMLInputElement;
  private readonly markdownInput: HTMLInputElement;
  private readonly clippingInput: HTMLInputElement;
  private readonly pdfInput?: HTMLInputElement;
  private readonly directPdfInput?: HTMLInputElement;
  readonly choosePdfDocument?: () => Promise<ReaderPdfDocumentSelection | undefined>;
  readonly choosePdfPackage?: (
    onProgress: (progress: ReaderProcessingProgress) => void
  ) => Promise<BrowserDirectoryReaderFileSystem | import("./remote-package-reader-file-system").RemotePackageReaderFileSystem | undefined>;

  constructor(options: boolean | BrowserPackagePickerOptions = true) {
    // The boolean form is retained for existing Local Reader callers. It has
    // always selected remote versus in-browser projection, not disabled PDF
    // projection entirely.
    const enableProcessingApi = typeof options === "boolean"
      ? options
      : options.enableProcessingApi !== false;
    const allowPdfProjection = typeof options === "boolean"
      ? true
      : options.allowPdfProjection !== false;
    const allowDirectPdfOpen = typeof options === "boolean"
      ? false
      : options.allowDirectPdfOpen === true;
    this.input = document.createElement("input");
    this.input.type = "file";
    this.input.multiple = true;
    this.input.setAttribute("webkitdirectory", "");
    this.input.className = "p2md-local-folder-input";
    document.body.appendChild(this.input);
    this.markdownInput = document.createElement("input");
    this.markdownInput.type = "file";
    this.markdownInput.accept = ".md,text/markdown,text/plain";
    this.markdownInput.className = "p2md-local-folder-input";
    document.body.appendChild(this.markdownInput);
    this.clippingInput = document.createElement("input");
    this.clippingInput.type = "file";
    this.clippingInput.multiple = true;
    this.clippingInput.accept = ".md,.html,.htm,.paper2md.zip,.mineru.zip,.zip,text/markdown,text/html,application/zip,image/png,image/jpeg,image/webp,image/gif,image/bmp";
    this.clippingInput.className = "p2md-local-folder-input";
    document.body.appendChild(this.clippingInput);
    if (allowDirectPdfOpen) {
      const directPdfInput = document.createElement("input");
      directPdfInput.type = "file";
      directPdfInput.accept = ".pdf,application/pdf";
      directPdfInput.dataset.readerPdfMode = "direct";
      directPdfInput.className = "p2md-local-folder-input";
      document.body.appendChild(directPdfInput);
      this.directPdfInput = directPdfInput;
      this.choosePdfDocument = async () => {
        const file = await this.chooseSingleFile(directPdfInput);
        return file ? createDirectPdfDocument(file) : undefined;
      };
    }
    if (allowPdfProjection) {
      const pdfInput = document.createElement("input");
      pdfInput.type = "file";
      pdfInput.accept = ".pdf,application/pdf";
      pdfInput.dataset.readerPdfMode = "projection";
      pdfInput.className = "p2md-local-folder-input";
      document.body.appendChild(pdfInput);
      this.pdfInput = pdfInput;
      const apiBaseUrl = enableProcessingApi ? configuredProcessingApiBaseUrl() : undefined;
      if (apiBaseUrl) {
        const client = new ProcessingClient(apiBaseUrl);
        this.choosePdfPackage = async (onProgress) => {
          const file = await this.chooseSingleFile(pdfInput);
          return file ? client.processPdf(file, onProgress) : undefined;
        };
      } else {
        this.choosePdfPackage = async (onProgress) => {
          const file = await this.chooseSingleFile(pdfInput);
          return file ? (await processBrowserPdf(file, onProgress)).fileSystem : undefined;
        };
      }
    }
  }

  async chooseMarkdownDocument(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const file = await this.chooseSingleFile(this.markdownInput);
    return file ? BrowserDirectoryReaderFileSystem.fromFileList([file]) : undefined;
  }

  async chooseWebClipping(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const files = await this.chooseFiles(this.clippingInput);
    if (!files.length) return undefined;
    if (files.length === 1 && /\.after-mineru\.zip$/i.test(files[0].name)) {
      return importAfterMinerUArchiveFile(files[0]);
    }
    if (files.length === 1 && /\.mineru\.zip$/i.test(files[0].name)) {
      const imported = await importMinerUArchiveFile(files[0]);
      return BrowserDirectoryReaderFileSystem.fromMinerUArchive(
        mineruArchiveRootLabel(files[0].name),
        imported.files,
        {
          format: "mineru-zip",
          sourceArchive: imported.sourceArchive,
          sourceRootPrefix: imported.rootPrefix,
          articlePath: imported.articlePath,
          contentListPath: imported.contentListPath,
          fileCount: imported.fileCount,
          markdownCount: imported.markdownCount,
          jsonCount: imported.jsonCount,
          imageCount: imported.imageCount
        }
      );
    }
    if (files.length === 1 && /(?:\.paper2md)?\.zip$/i.test(files[0].name)) {
      assertClippingArchiveByteLength(files[0].size);
      const entries = extractClippingArchiveBytes(new Uint8Array(await files[0].arrayBuffer()));
      return BrowserDirectoryReaderFileSystem.fromFileMap(clippingArchiveRootLabel(files[0].name), entries);
    }
    if (files.some((file) => /\.zip$/i.test(file.name))) {
      throw new Error("Select one clipping ZIP archive at a time.");
    }
    return BrowserDirectoryReaderFileSystem.fromFileList(files);
  }

  async choosePackage(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    const forceInputFallback = new URLSearchParams(window.location.search).has("folder-input");
    if (picker && !forceInputFallback) {
      try {
        const handle = await picker.call(window, { mode: "read" });
        return BrowserDirectoryReaderFileSystem.fromDirectoryHandle(handle);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return undefined;
        throw error;
      }
    }
    return new Promise((resolve) => {
      const onChange = () => {
        const files = [...(this.input.files ?? [])];
        this.input.value = "";
        resolve(files.length ? BrowserDirectoryReaderFileSystem.fromFileList(files) : undefined);
      };
      this.input.addEventListener("change", onChange, { once: true });
      this.input.click();
    });
  }

  dispose(): void {
    this.input.remove();
    this.markdownInput.remove();
    this.clippingInput.remove();
    this.directPdfInput?.remove();
    this.pdfInput?.remove();
  }

  private chooseSingleFile(input: HTMLInputElement): Promise<File | undefined> {
    return new Promise((resolve) => {
      const onChange = () => {
        const file = input.files?.[0];
        input.value = "";
        resolve(file);
      };
      input.addEventListener("change", onChange, { once: true });
      input.click();
    });
  }

  private chooseFiles(input: HTMLInputElement): Promise<File[]> {
    return new Promise((resolve) => {
      const onChange = () => {
        const files = [...(input.files ?? [])];
        input.value = "";
        resolve(files);
      };
      input.addEventListener("change", onChange, { once: true });
      input.click();
    });
  }
}
