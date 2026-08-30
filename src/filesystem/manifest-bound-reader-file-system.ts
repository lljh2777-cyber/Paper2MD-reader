import {
  AfterMinerUPackageValidationError,
  type AfterMinerUFileRecord,
  isSafeAfterMinerUPath,
  sha256Bytes
} from "../../packages/after-mineru-contract/src/index";
import type { ReaderFileInfo, ReaderFileSystem } from "./reader-file-system";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp"
});

function contentType(path: string): string {
  return MIME_BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/**
 * A post-validation capability view over an After-MinerU package.
 *
 * It exposes only manifest records and compatibility aliases. Every byte read
 * is copied and checked against its bound size and SHA-256 before it crosses
 * into a renderer, PDF runtime, or visual resolver.
 */
export class ManifestBoundReaderFileSystem implements ReaderFileSystem {
  readonly rootLabel: string;
  private readonly records = new Map<string, AfterMinerUFileRecord>();
  private readonly objectUrls = new Set<string>();

  constructor(
    private readonly source: ReaderFileSystem,
    records: Iterable<AfterMinerUFileRecord>
  ) {
    this.rootLabel = source.rootLabel;
    for (const entry of records) {
      if (!isSafeAfterMinerUPath(entry.path) || this.records.has(entry.path)) {
        throw new AfterMinerUPackageValidationError(`Manifest-bound content path is invalid or duplicated: ${entry.path}`);
      }
      this.records.set(entry.path, { path: entry.path, size: entry.size, sha256: entry.sha256 });
    }
  }

  isBoundPath(path: string): boolean {
    return this.records.has(path);
  }

  resolvePath(relativePath: string): string {
    this.requireRecord(relativePath);
    return this.source.resolvePath(relativePath);
  }

  async exists(relativePath: string): Promise<boolean> {
    if (!this.records.has(relativePath)) return false;
    return Boolean(await this.fileInfo(relativePath));
  }

  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> {
    const expected = this.requireRecord(relativePath);
    const actual = await this.source.fileInfo(relativePath);
    if (!actual) return undefined;
    if (actual.size !== expected.size) {
      throw new AfterMinerUPackageValidationError(`Manifest-bound file size changed: ${relativePath}`);
    }
    return { size: expected.size };
  }

  async readText(relativePath: string): Promise<string> {
    const bytes = new Uint8Array(await this.readBinary(relativePath));
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AfterMinerUPackageValidationError(`Manifest-bound text is not valid UTF-8: ${relativePath}`);
    }
  }

  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    const expected = this.requireRecord(relativePath);
    const info = await this.source.fileInfo(relativePath);
    if (!info || info.size !== expected.size) {
      throw new AfterMinerUPackageValidationError(`Manifest-bound file size changed: ${relativePath}`);
    }
    const value = await this.source.readBinary(relativePath);
    const bytes = new Uint8Array(value).slice();
    if (bytes.byteLength !== expected.size || sha256Bytes(bytes) !== expected.sha256) {
      throw new AfterMinerUPackageValidationError(`Manifest-bound file bytes changed: ${relativePath}`);
    }
    return bytes.buffer;
  }

  async listFiles(relativeDirectory: string): Promise<string[]> {
    if (relativeDirectory && !isSafeAfterMinerUPath(relativeDirectory)) {
      throw new AfterMinerUPackageValidationError(`Manifest-bound directory path is invalid: ${relativeDirectory}`);
    }
    const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
    return [...this.records.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .sort();
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    const bytes = await this.readBinary(relativePath);
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType(relativePath) }));
    this.objectUrls.add(url);
    return url;
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  private requireRecord(path: string): AfterMinerUFileRecord {
    const record = this.records.get(path);
    if (!record) throw new AfterMinerUPackageValidationError(`Path is not bound by the After-MinerU manifest: ${path}`);
    return record;
  }
}
