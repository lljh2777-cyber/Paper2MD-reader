export * from "../../../src/filesystem/reader-file-system";
export * from "../../../src/model/clipping-markdown";
export * from "../../../src/model/clipping-html";
export * from "../../../src/model/clipping-archive";
export * from "../../../src/model/contract-validation";
export * from "../../../src/model/manifest-validation";
export * from "../../../src/model/mineru-content-list";
export * from "../../../src/model/package-limits";
export * from "../../../src/model/package-loader";
export * from "../../../src/model/package-source";
export * from "../../../src/model/reader-contract";
export * from "../../after-mineru-contract/src/index";

export interface ReaderPdfDocumentSelection {
  /** The selected PDF remains inside the host-owned, read-only file system. */
  fileSystem: import("../../../src/filesystem/reader-file-system").ReaderFileSystem;
  /** Safe package-relative path used only by the PDF rendering runtime. */
  pdfPath: string;
  /** Human-readable filename shown by the Reader shell. */
  label: string;
}

export interface ReaderPackagePicker {
  readonly platform: "web" | "desktop" | "obsidian";
  choosePackage(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  chooseMarkdownDocument?(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  chooseWebClipping?(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  /** Open an original PDF for rendering only, without producing a Markdown package. */
  choosePdfDocument?(): Promise<ReaderPdfDocumentSelection | undefined>;
  /** Convert a PDF into a generated Markdown package. Kept separate from direct PDF opening. */
  choosePdfPackage?(
    onProgress: (progress: ReaderProcessingProgress) => void
  ): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  dispose?(): void;
}

export interface ReaderProcessingProgress {
  state: "uploading" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: "upload" | "extract" | "validate" | "publish" | "complete";
  message: string;
}
