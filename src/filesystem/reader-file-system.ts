export interface ReaderFileInfo {
  size: number;
}

export interface ReaderFileSystem {
  readonly rootLabel: string;
  resolvePath(relativePath: string): string;
  exists(relativePath: string): Promise<boolean>;
  fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined>;
  readText(relativePath: string): Promise<string>;
  readBinary(relativePath: string): Promise<ArrayBuffer>;
  listFiles(relativeDirectory: string): Promise<string[]>;
  resolveAssetUrl(relativePath: string): Promise<string>;
  dispose(): void;
}

export function normalizeReaderPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function joinReaderPath(directory: string, path: string): string {
  const prefix = normalizeReaderPath(directory).replace(/\/$/, "");
  const suffix = normalizeReaderPath(path).replace(/^\//, "");
  return prefix ? `${prefix}/${suffix}` : suffix;
}
