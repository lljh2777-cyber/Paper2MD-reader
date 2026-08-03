import { isSafeRelativePath } from "../src/model/contract-validation";
import { ReaderFileInfo, ReaderFileSystem } from "../src/filesystem/reader-file-system";

export class MemoryReaderFileSystem implements ReaderFileSystem {
  readonly rootLabel = "fixture";
  private readonly files = new Map<string, Uint8Array>();

  constructor(entries: Record<string, string | Uint8Array>) {
    Object.entries(entries).forEach(([path, value]) => {
      this.files.set(path, typeof value === "string" ? new TextEncoder().encode(value) : value);
    });
  }

  resolvePath(relativePath: string): string {
    this.assertSafe(relativePath);
    return `fixture/${relativePath}`;
  }

  async exists(relativePath: string): Promise<boolean> {
    this.assertSafe(relativePath);
    return this.files.has(relativePath);
  }

  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    this.assertSafe(relativePath);
    const bytes = this.files.get(relativePath);
    return bytes ? { size: bytes.byteLength } : undefined;
  }

  async readText(relativePath: string): Promise<string> {
    return new TextDecoder().decode(await this.bytes(relativePath));
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    const bytes = await this.bytes(relativePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async listFiles(relativeDirectory: string): Promise<string[]> {
    if (relativeDirectory) this.assertSafe(relativeDirectory);
    const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    await this.bytes(relativePath);
    return `memory://${relativePath}`;
  }

  dispose(): void {}

  private async bytes(relativePath: string): Promise<Uint8Array> {
    this.assertSafe(relativePath);
    const bytes = this.files.get(relativePath);
    if (!bytes) throw new Error(`Missing fixture: ${relativePath}`);
    return bytes;
  }

  private assertSafe(path: string): void {
    if (!isSafeRelativePath(path)) throw new Error(`Unsafe package path: ${path}`);
  }
}
