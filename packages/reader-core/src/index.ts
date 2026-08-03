export * from "../../../src/filesystem/reader-file-system";
export * from "../../../src/model/contract-validation";
export * from "../../../src/model/manifest-validation";
export * from "../../../src/model/package-limits";
export * from "../../../src/model/package-loader";
export * from "../../../src/model/reader-contract";

export interface ReaderPackagePicker {
  readonly platform: "web" | "desktop" | "obsidian";
  choosePackage(): Promise<import("../../../src/filesystem/reader-file-system").ReaderFileSystem | undefined>;
  dispose?(): void;
}
