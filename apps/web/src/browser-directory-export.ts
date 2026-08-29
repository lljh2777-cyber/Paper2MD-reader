import { isSafeRelativePath } from "../../../src/model/contract-validation";
import { normalizeReaderPath } from "../../../src/filesystem/reader-file-system";

interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}

export interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

export interface FreshDirectoryExportResult {
  folderName: string;
  fileCount: number;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
}

async function entryExists(directory: DirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (errorName(error) === "TypeMismatchError") return true;
    if (errorName(error) !== "NotFoundError") throw error;
  }
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (errorName(error) === "TypeMismatchError") return true;
    if (errorName(error) === "NotFoundError") return false;
    throw error;
  }
}

function safeFolderStem(preferredName: string): string {
  const stem = preferredName
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*#]+/gu, "-")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, 80);
  if (!stem || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(stem)) {
    return "after-mineru-result";
  }
  return stem;
}

function defaultNonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function plannedFiles(files: ReadonlyMap<string, File>): Array<{ path: string; segments: string[]; file: File }> {
  if (!files.size) throw new Error("没有可写入的结果文件。");
  const planned: Array<{ path: string; segments: string[]; file: File }> = [];
  const canonicalPaths = new Set<string>();
  const canonicalDirectories = new Map<string, string>();
  for (const [rawPath, file] of files) {
    const path = normalizeReaderPath(rawPath);
    if (!isSafeRelativePath(path)) throw new Error(`导出路径不安全：${rawPath}`);
    const segments = path.split("/");
    const canonical = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (canonicalPaths.has(canonical)) throw new Error(`导出路径发生本地冲突：${path}`);
    canonicalPaths.add(canonical);
    planned.push({ path, segments, file });
  }
  for (const { path, segments } of planned) {
    for (let index = 1; index < segments.length; index += 1) {
      const directoryPath = segments.slice(0, index).join("/");
      const canonicalDirectory = directoryPath.normalize("NFKC").toLocaleLowerCase("en-US");
      if (canonicalPaths.has(canonicalDirectory)) throw new Error(`导出文件与目录冲突：${path}`);
      const previous = canonicalDirectories.get(canonicalDirectory);
      if (previous && previous !== directoryPath) throw new Error(`导出目录发生本地冲突：${directoryPath}`);
      canonicalDirectories.set(canonicalDirectory, directoryPath);
    }
  }
  return planned.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

export async function writePackageToFreshDirectory(
  root: DirectoryHandleLike,
  preferredName: string,
  files: ReadonlyMap<string, File>,
  nonce: () => string = defaultNonce
): Promise<FreshDirectoryExportResult> {
  const planned = plannedFiles(files);
  const stem = safeFolderStem(preferredName);
  let folderName = "";
  let folder: DirectoryHandleLike | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${stem}-${nonce().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "new"}`;
    if (await entryExists(root, candidate)) continue;
    folderName = candidate;
    folder = await root.getDirectoryHandle(candidate, { create: true });
    break;
  }
  if (!folder) throw new Error("无法分配新的导出目录；请重试。");

  const createdDirectories = new Map<string, DirectoryHandleLike>([["", folder]]);
  for (const { path, segments, file } of planned) {
    const filename = segments.at(-1)!;
    let parent = folder;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const directoryPath = segments.slice(0, index + 1).join("/");
      const existing = createdDirectories.get(directoryPath);
      if (existing) {
        parent = existing;
        continue;
      }
      const segment = segments[index]!;
      if (await entryExists(parent, segment)) {
        throw new Error(`新导出目录出现并发冲突：${directoryPath}`);
      }
      parent = await parent.getDirectoryHandle(segment, { create: true });
      createdDirectories.set(directoryPath, parent);
    }
    if (await entryExists(parent, filename)) throw new Error(`新导出目录出现并发冲突：${path}`);
    const handle = await parent.getFileHandle(filename, { create: true });
    if ((await handle.getFile()).size !== 0) throw new Error(`新导出文件已被并发写入：${path}`);
    const writable = await handle.createWritable();
    let complete = false;
    try {
      await writable.write(file);
      await writable.close();
      complete = true;
    } finally {
      if (!complete && writable.abort) await writable.abort().catch(() => undefined);
    }
  }
  return { folderName, fileCount: planned.length };
}
