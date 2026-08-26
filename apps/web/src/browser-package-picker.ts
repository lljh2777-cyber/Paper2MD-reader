import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";
import { ReaderPackagePicker } from "../../../packages/reader-core/src/index";
import type { ReaderProcessingProgress } from "../../../packages/reader-core/src/index";
import { configuredProcessingApiBaseUrl, ProcessingClient } from "./processing-client";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

export class BrowserPackagePicker implements ReaderPackagePicker {
  readonly platform = "web" as const;
  private readonly input: HTMLInputElement;
  private readonly markdownInput: HTMLInputElement;
  private readonly clippingInput: HTMLInputElement;
  private readonly pdfInput: HTMLInputElement;
  readonly choosePdfPackage?: (
    onProgress: (progress: ReaderProcessingProgress) => void
  ) => Promise<BrowserDirectoryReaderFileSystem | import("./remote-package-reader-file-system").RemotePackageReaderFileSystem | undefined>;

  constructor() {
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
    this.clippingInput.accept = ".md,.html,.htm,text/markdown,text/html,image/png,image/jpeg,image/webp,image/gif,image/bmp";
    this.clippingInput.className = "p2md-local-folder-input";
    document.body.appendChild(this.clippingInput);
    this.pdfInput = document.createElement("input");
    this.pdfInput.type = "file";
    this.pdfInput.accept = ".pdf,application/pdf";
    this.pdfInput.className = "p2md-local-folder-input";
    document.body.appendChild(this.pdfInput);
    const apiBaseUrl = configuredProcessingApiBaseUrl();
    if (apiBaseUrl) {
      const client = new ProcessingClient(apiBaseUrl);
      this.choosePdfPackage = async (onProgress) => {
        const file = await this.chooseSingleFile(this.pdfInput);
        return file ? client.processPdf(file, onProgress) : undefined;
      };
    }
  }

  async chooseMarkdownDocument(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const file = await this.chooseSingleFile(this.markdownInput);
    return file ? BrowserDirectoryReaderFileSystem.fromFileList([file]) : undefined;
  }

  async chooseWebClipping(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const files = await this.chooseFiles(this.clippingInput);
    return files.length ? BrowserDirectoryReaderFileSystem.fromFileList(files) : undefined;
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
    this.pdfInput.remove();
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
