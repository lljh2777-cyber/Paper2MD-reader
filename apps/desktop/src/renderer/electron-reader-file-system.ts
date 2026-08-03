import { isSafeRelativePath } from "../../../../src/model/contract-validation";
import { normalizeReaderPath, ReaderFileInfo, ReaderFileSystem } from "../../../../src/filesystem/reader-file-system";
import { DesktopRootSelection, Paper2MDDesktopApi } from "../shared/desktop-api";

function mimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "bmp") return "image/bmp";
  return "application/octet-stream";
}

export class ElectronReaderFileSystem implements ReaderFileSystem {
  readonly rootLabel: string;
  private readonly objectUrls = new Map<string, string>();

  constructor(private readonly api: Paper2MDDesktopApi, private readonly root: DesktopRootSelection) {
    this.rootLabel = root.label;
  }

  resolvePath(relativePath: string): string {
    return `${this.rootLabel}/${this.safePath(relativePath)}`;
  }

  exists(relativePath: string): Promise<boolean> {
    return this.api.fileExists(this.root.id, this.safePath(relativePath));
  }

  fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    return this.api.fileInfo(this.root.id, this.safePath(relativePath));
  }

  readText(relativePath: string): Promise<string> {
    return this.api.readText(this.root.id, this.safePath(relativePath));
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    const bytes = await this.api.readBinary(this.root.id, this.safePath(relativePath));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  listFiles(relativeDirectory: string): Promise<string[]> {
    return this.api.listFiles(this.root.id, relativeDirectory ? this.safePath(relativeDirectory) : "");
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    const path = this.safePath(relativePath);
    const cached = this.objectUrls.get(path);
    if (cached) return cached;
    if (path.toLowerCase().endsWith(".svg")) throw new Error("SVG assets are disabled in the desktop Reader");
    const bytes = await this.api.readBinary(this.root.id, path);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType(path) }));
    this.objectUrls.set(path, url);
    return url;
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  private safePath(value: string): string {
    const path = normalizeReaderPath(value);
    if (!isSafeRelativePath(path)) throw new Error(`Unsafe package path: ${value}`);
    return path;
  }
}
