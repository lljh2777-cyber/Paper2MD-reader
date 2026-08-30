import { isSafeRelativePath } from "../model/contract-validation";
import { normalizeReaderPath, ReaderFileInfo, ReaderFileSystem } from "./reader-file-system";
import { PACKAGE_LIMITS, PackageLimitError } from "../model/package-limits";
import { AFTER_MINERU_PACKAGE_LIMITS } from "../../packages/after-mineru-contract/src/index";

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

export interface BrowserMinerUArchiveSource {
  format: "mineru-zip";
  sourceArchive: File;
  sourceRootPrefix: string;
  articlePath: string;
  contentListPath: string;
  fileCount: number;
  markdownCount: number;
  jsonCount: number;
  imageCount: number;
}

export class BrowserDirectoryReaderFileSystem implements ReaderFileSystem {
  private readonly objectUrls = new Map<string, string>();

  private constructor(
    readonly rootLabel: string,
    private readonly directory?: FileSystemDirectoryHandle,
    private readonly files?: Map<string, File>,
    readonly sourceArchive?: BrowserMinerUArchiveSource
  ) {}

  static fromDirectoryHandle(directory: FileSystemDirectoryHandle): BrowserDirectoryReaderFileSystem {
    return new BrowserDirectoryReaderFileSystem(directory.name, directory);
  }

  static fromFileList(fileList: FileList | File[]): BrowserDirectoryReaderFileSystem {
    const files = [...fileList];
    if (files.length > PACKAGE_LIMITS.browserInputFiles) {
      throw new PackageLimitError(
        `The selection contains ${files.length} files; the safe limit is ${PACKAGE_LIMITS.browserInputFiles}.`,
        files.length,
        PACKAGE_LIMITS.browserInputFiles
      );
    }
    const firstRelativePath = files[0]?.webkitRelativePath ?? "";
    const rootLabel = firstRelativePath.split("/")[0] || "Local package";
    const index = new Map<string, File>();

    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      const segments = normalizeReaderPath(relativePath).split("/");
      if (segments[0] === rootLabel && segments.length > 1) segments.shift();
      const packagePath = segments.join("/");
      if (!isSafeRelativePath(packagePath)) continue;
      if (index.has(packagePath)) throw new Error(`Duplicate normalized package path: ${packagePath}`);
      index.set(packagePath, file);
    }

    return new BrowserDirectoryReaderFileSystem(rootLabel, undefined, index);
  }

  static fromFileMap(rootLabel: string, files: ReadonlyMap<string, File>): BrowserDirectoryReaderFileSystem {
    if (files.size > PACKAGE_LIMITS.browserInputFiles) {
      throw new PackageLimitError(
        `The selection contains ${files.size} files; the safe limit is ${PACKAGE_LIMITS.browserInputFiles}.`,
        files.size,
        PACKAGE_LIMITS.browserInputFiles
      );
    }
    const index = new Map<string, File>();
    for (const [path, file] of files) {
      const normalized = normalizeReaderPath(path);
      if (!isSafeRelativePath(normalized)) throw new Error(`Unsafe package path: ${path}`);
      if (index.has(normalized)) throw new Error(`Duplicate normalized package path: ${normalized}`);
      index.set(normalized, file);
    }
    return new BrowserDirectoryReaderFileSystem(rootLabel || "Web clipping", undefined, index);
  }

  static fromAfterMinerUArchive(rootLabel: string, files: ReadonlyMap<string, File>): BrowserDirectoryReaderFileSystem {
    if (files.size > AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount) {
      throw new PackageLimitError(
        `The After-MinerU package contains ${files.size} files; the safe limit is ${AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount}.`,
        files.size,
        AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount
      );
    }
    const index = new Map<string, File>();
    const canonicalPaths = new Set<string>();
    for (const [path, file] of files) {
      const normalized = normalizeReaderPath(path);
      if (!isSafeRelativePath(normalized)) throw new Error(`Unsafe After-MinerU package path: ${path}`);
      const canonical = normalized.normalize("NFKC").toLocaleLowerCase("en-US");
      if (canonicalPaths.has(canonical)) throw new Error(`Duplicate normalized After-MinerU package path: ${normalized}`);
      canonicalPaths.add(canonical);
      index.set(normalized, file);
    }
    return new BrowserDirectoryReaderFileSystem(rootLabel || "After-MinerU package", undefined, index);
  }

  static fromMinerUArchive(
    rootLabel: string,
    files: ReadonlyMap<string, File>,
    sourceArchive: BrowserMinerUArchiveSource
  ): BrowserDirectoryReaderFileSystem {
    const fileSystem = BrowserDirectoryReaderFileSystem.fromFileMap(rootLabel || "MinerU result", files);
    return new BrowserDirectoryReaderFileSystem(
      fileSystem.rootLabel,
      undefined,
      fileSystem.files,
      sourceArchive
    );
  }

  resolvePath(relativePath: string): string {
    const safePath = this.safePath(relativePath);
    return `${this.rootLabel}/${safePath}`;
  }

  async exists(relativePath: string): Promise<boolean> {
    return Boolean(await this.getFile(relativePath));
  }

  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    const file = await this.getFile(relativePath);
    return file ? { size: file.size } : undefined;
  }

  async readText(relativePath: string): Promise<string> {
    return (await this.requireFile(relativePath)).text();
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    return (await this.requireFile(relativePath)).arrayBuffer();
  }

  async listFiles(relativeDirectory: string): Promise<string[]> {
    const directoryPath = relativeDirectory ? this.safePath(relativeDirectory) : "";
    if (this.files) {
      const prefix = directoryPath ? `${directoryPath}/` : "";
      return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
    }

    try {
      const handle = directoryPath ? await this.getDirectoryHandle(directoryPath) : this.directory;
      if (!handle) return [];
      const paths: string[] = [];
      for await (const entry of (handle as IterableDirectoryHandle).values()) {
        if (entry.kind === "file") paths.push(directoryPath ? `${directoryPath}/${entry.name}` : entry.name);
      }
      return paths;
    } catch {
      return [];
    }
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    const safePath = this.safePath(relativePath);
    const cached = this.objectUrls.get(safePath);
    if (cached) return cached;
    const file = await this.requireFile(safePath);
    if (file.type === "image/svg+xml" || safePath.toLowerCase().endsWith(".svg")) {
      throw new Error("SVG assets are not loaded by the local browser host.");
    }
    const url = URL.createObjectURL(file);
    this.objectUrls.set(safePath, url);
    return url;
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  private async requireFile(relativePath: string): Promise<File> {
    const file = await this.getFile(relativePath);
    if (!file) throw new Error(`File not found: ${this.safePath(relativePath)}`);
    return file;
  }

  private async getFile(relativePath: string): Promise<File | undefined> {
    const safePath = this.safePath(relativePath);
    if (this.files) return this.files.get(safePath);
    if (!this.directory) return undefined;

    try {
      const segments = safePath.split("/");
      const filename = segments.pop();
      if (!filename) return undefined;
      let directory = this.directory;
      for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
      return await (await directory.getFileHandle(filename)).getFile();
    } catch {
      return undefined;
    }
  }

  private async getDirectoryHandle(relativePath: string): Promise<FileSystemDirectoryHandle> {
    if (!this.directory) throw new Error("Directory handle unavailable");
    let directory = this.directory;
    for (const segment of relativePath.split("/").filter(Boolean)) {
      directory = await directory.getDirectoryHandle(segment);
    }
    return directory;
  }

  private safePath(path: string): string {
    const normalized = normalizeReaderPath(path);
    if (!isSafeRelativePath(normalized)) throw new Error(`Unsafe package path: ${path}`);
    return normalized;
  }
}
