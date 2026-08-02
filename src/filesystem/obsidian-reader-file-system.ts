import { App, normalizePath, TFile, TFolder } from "obsidian";
import { isSafeRelativePath } from "../model/contract-validation";
import { joinReaderPath, normalizeReaderPath, ReaderFileInfo, ReaderFileSystem } from "./reader-file-system";

export class ObsidianReaderFileSystem implements ReaderFileSystem {
  readonly rootLabel: string;

  constructor(private readonly app: App, private readonly packageRoot: string) {
    this.rootLabel = packageRoot.split("/").pop() || "Vault root";
  }

  resolvePath(relativePath: string): string {
    this.assertSafe(relativePath);
    return normalizePath(joinReaderPath(this.packageRoot, relativePath));
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(this.resolvePath(relativePath)) instanceof TFile;
  }

  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    const file = this.app.vault.getAbstractFileByPath(this.resolvePath(relativePath));
    return file instanceof TFile ? { size: file.stat.size } : undefined;
  }

  async readText(relativePath: string): Promise<string> {
    const file = this.requireFile(relativePath);
    return this.app.vault.cachedRead(file);
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.requireFile(relativePath));
  }

  async listFiles(relativeDirectory: string): Promise<string[]> {
    this.assertSafe(relativeDirectory);
    const folder = this.app.vault.getAbstractFileByPath(this.resolvePath(relativeDirectory));
    if (!(folder instanceof TFolder)) return [];
    return folder.children
      .filter((child): child is TFile => child instanceof TFile)
      .map((file) => normalizeReaderPath(joinReaderPath(relativeDirectory, file.name)));
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    const file = this.requireFile(relativePath);
    return this.app.vault.getResourcePath(file);
  }

  dispose(): void {
    // Obsidian owns Vault resource URLs.
  }

  private requireFile(relativePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(this.resolvePath(relativePath));
    if (!(file instanceof TFile)) throw new Error(`File not found: ${normalizeReaderPath(relativePath)}`);
    return file;
  }

  private assertSafe(path: string): void {
    if (!isSafeRelativePath(normalizeReaderPath(path))) throw new Error(`Unsafe package path: ${path}`);
  }
}
