export * from "../../../src/filesystem/reader-file-system";
export * from "../../../src/model/clipping-markdown";
export * from "../../../src/model/clipping-html";
export * from "../../../src/model/contract-validation";
export * from "../../../src/model/manifest-validation";
export * from "../../../src/model/mineru-content-list";
export * from "../../../src/model/package-limits";
export * from "../../../src/model/package-loader";
export * from "../../../src/model/package-source";
export * from "../../../src/model/reader-contract";

export interface ReaderPackagePicker {
  readonly platform: "web" | "desktop" | "obsidian";
  choosePackage(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  chooseMarkdownDocument?(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  chooseWebClipping?(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
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
