import { unzipSync } from "fflate";
import { isSafeRelativePath } from "./contract-validation";
import { PACKAGE_LIMITS, PackageLimitError } from "./package-limits";

export const CLIPPING_ARCHIVE_EXTENSION = ".paper2md.zip";
export const CLIPPING_ARCHIVE_COMPRESSED_BYTES = 64 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".png": "image/png",
  ".webp": "image/webp"
};

function normalizedArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!isSafeRelativePath(normalized)) throw new Error(`Unsafe clipping archive path: ${value}`);
  return normalized;
}

function mimeType(path: string): string {
  const extension = /\.[^.]+$/.exec(path.toLowerCase())?.[0] ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function assertClippingArchiveByteLength(byteLength: number): void {
  if (byteLength > CLIPPING_ARCHIVE_COMPRESSED_BYTES) {
    throw new PackageLimitError(
      `The clipping archive is ${byteLength} bytes; the safe limit is ${CLIPPING_ARCHIVE_COMPRESSED_BYTES}.`,
      byteLength,
      CLIPPING_ARCHIVE_COMPRESSED_BYTES
    );
  }
}

/**
 * Expand a browser-clipped paper only after checking every ZIP entry's declared
 * size and normalized path. The returned files are in-memory Reader inputs;
 * the source archive and article.md are never changed.
 */
export function extractClippingArchiveBytes(bytes: Uint8Array): Map<string, File> {
  assertClippingArchiveByteLength(bytes.byteLength);

  const seen = new Set<string>();
  let fileCount = 0;
  let declaredBytes = 0;
  const extracted = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.replace(/\\/g, "/").endsWith("/")) return false;
      const path = normalizedArchivePath(entry.name);
      if (seen.has(path.toLowerCase())) throw new Error(`Duplicate normalized clipping archive path: ${path}`);
      seen.add(path.toLowerCase());
      fileCount += 1;
      if (fileCount > PACKAGE_LIMITS.browserInputFiles) {
        throw new PackageLimitError(
          `The clipping archive contains more than ${PACKAGE_LIMITS.browserInputFiles} files.`,
          fileCount,
          PACKAGE_LIMITS.browserInputFiles
        );
      }
      if (entry.originalSize > PACKAGE_LIMITS.assetBytes && path !== "article.md") {
        throw new PackageLimitError(
          `Clipping archive entry ${path} is ${entry.originalSize} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
          entry.originalSize,
          PACKAGE_LIMITS.assetBytes
        );
      }
      if (path === "article.md" && entry.originalSize > PACKAGE_LIMITS.articleBytes) {
        throw new PackageLimitError(
          `Clipping article.md is ${entry.originalSize} bytes; the safe limit is ${PACKAGE_LIMITS.articleBytes}.`,
          entry.originalSize,
          PACKAGE_LIMITS.articleBytes
        );
      }
      declaredBytes += entry.originalSize;
      if (declaredBytes > PACKAGE_LIMITS.totalAssetBytes + PACKAGE_LIMITS.articleBytes) {
        throw new PackageLimitError(
          `The expanded clipping archive exceeds the safe aggregate limit.`,
          declaredBytes,
          PACKAGE_LIMITS.totalAssetBytes + PACKAGE_LIMITS.articleBytes
        );
      }
      return true;
    }
  });

  const files = new Map<string, File>();
  let actualBytes = 0;
  for (const [rawPath, data] of Object.entries(extracted)) {
    const path = normalizedArchivePath(rawPath);
    const limit = path === "article.md" ? PACKAGE_LIMITS.articleBytes : PACKAGE_LIMITS.assetBytes;
    if (data.byteLength > limit) {
      throw new PackageLimitError(`Clipping archive entry ${path} exceeds its safe size limit.`, data.byteLength, limit);
    }
    actualBytes += data.byteLength;
    if (actualBytes > PACKAGE_LIMITS.totalAssetBytes + PACKAGE_LIMITS.articleBytes) {
      throw new PackageLimitError(
        "The expanded clipping archive exceeds the safe aggregate limit.",
        actualBytes,
        PACKAGE_LIMITS.totalAssetBytes + PACKAGE_LIMITS.articleBytes
      );
    }
    files.set(path, new File([data], path.split("/").pop() ?? path, { type: mimeType(path) }));
  }
  if (!files.has("article.md")) throw new Error("The clipping archive does not contain article.md.");
  return files;
}

export function clippingArchiveRootLabel(filename: string): string {
  const label = filename.replace(/\.paper2md\.zip$/i, "").replace(/\.zip$/i, "").trim();
  return label || "Web clipping";
}
