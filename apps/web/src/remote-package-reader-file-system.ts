import { isSafeRelativePath } from "../../../src/model/contract-validation";
import { normalizeReaderPath, ReaderFileInfo, ReaderFileSystem } from "../../../src/filesystem/reader-file-system";

export interface RemotePackageFile {
  path: string;
  size: number;
  sha256: string;
}

export interface RemotePackageDescriptor {
  packageId: string;
  label: string;
  files: RemotePackageFile[];
}

export class RemotePackageReaderFileSystem implements ReaderFileSystem {
  private readonly files = new Map<string, RemotePackageFile>();
  private readonly objectUrls = new Map<string, string>();

  constructor(
    readonly rootLabel: string,
    private readonly apiBaseUrl: string,
    private readonly packageId: string,
    files: readonly RemotePackageFile[]
  ) {
    files.forEach((file) => {
      const path = normalizeReaderPath(file.path);
      if (!isSafeRelativePath(path) || !Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error("Processing service returned an unsafe package index");
      }
      this.files.set(path, { ...file, path });
    });
  }

  resolvePath(relativePath: string): string {
    return `${this.rootLabel}/${this.normalizedPath(relativePath)}`;
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.files.has(this.normalizedPath(relativePath));
  }

  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    const file = this.files.get(this.normalizedPath(relativePath));
    return file ? { size: file.size } : undefined;
  }

  async readText(relativePath: string): Promise<string> {
    return (await this.fetchFile(relativePath)).text();
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    return (await this.fetchFile(relativePath)).arrayBuffer();
  }

  async listFiles(relativeDirectory: string): Promise<string[]> {
    const directory = relativeDirectory ? this.normalizedPath(relativeDirectory) : "";
    const prefix = directory ? `${directory}/` : "";
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    const path = this.safePath(relativePath);
    const cached = this.objectUrls.get(path);
    if (cached) return cached;
    if (path.toLowerCase().endsWith(".svg")) throw new Error("SVG package assets are not rendered.");
    const url = URL.createObjectURL(await this.fetchFile(path));
    this.objectUrls.set(path, url);
    return url;
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  private async fetchFile(relativePath: string): Promise<Blob> {
    const path = this.safePath(relativePath);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${this.apiBaseUrl}/packages/${encodeURIComponent(this.packageId)}/files/${encodedPath}`,
      { credentials: "include", headers: { Accept: "application/octet-stream" } }
    );
    if (!response.ok) throw new Error(`Package resource could not be loaded (${response.status})`);
    return response.blob();
  }

  private safePath(value: string): string {
    const path = this.normalizedPath(value);
    if (!this.files.has(path)) throw new Error(`Unsafe or unknown package path: ${value}`);
    return path;
  }

  private normalizedPath(value: string): string {
    const path = normalizeReaderPath(value);
    if (!isSafeRelativePath(path)) throw new Error(`Unsafe package path: ${value}`);
    return path;
  }
}
