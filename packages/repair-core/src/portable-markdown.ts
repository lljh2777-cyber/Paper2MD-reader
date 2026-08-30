import { zipSync, type Zippable } from "fflate";
import MarkdownIt from "markdown-it";
import {
  AFTER_MINERU_PACKAGE_LIMITS,
  type AfterMinerUFileRecord,
  type AfterMinerUManifest,
  type AfterMinerUReaderProjection,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  type SafeZipArchiveLimits,
  validateAfterMinerUPackage
} from "../../after-mineru-contract/src/index";

export const AFTER_MINERU_PORTABLE_VERSION = "after-mineru-portable-markdown-v1" as const;
export const AFTER_MINERU_PORTABLE_ARTICLE_PATH = "article.after-mineru.md" as const;
export const AFTER_MINERU_PORTABLE_MANIFEST_PATH = "after-mineru-portable.json" as const;

export const AFTER_MINERU_PORTABLE_LIMITS: Readonly<SafeZipArchiveLimits> = Object.freeze({
  archiveBytes: AFTER_MINERU_PACKAGE_LIMITS.compressedArchiveBytes,
  fileCount: 256,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: 64 * 1024 * 1024,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: AFTER_MINERU_PACKAGE_LIMITS.pathDepth
});

export type PortableMarkdownWarningCode =
  | "fragment-set-not-materialized"
  | "pdf-crop-not-materialized";

export type PortableMarkdownRepresentation = "portable-derived" | "source-assets-fallback";

export interface PortableMarkdownWarning {
  code: PortableMarkdownWarningCode;
  count: number;
}

export interface PortableMarkdownManifest {
  schema_version: 1;
  contract: typeof AFTER_MINERU_PORTABLE_VERSION;
  algorithm_version: string;
  source_archive_sha256: string;
  representation: PortableMarkdownRepresentation;
  article: AfterMinerUFileRecord;
  assets: AfterMinerUFileRecord[];
  warnings: PortableMarkdownWarning[];
}

export interface BuildPortableMarkdownExportInput {
  archiveName?: string;
  verifiedPackageFiles: ReadonlyMap<string, Uint8Array>;
  manifest: AfterMinerUManifest;
  readerProjection: AfterMinerUReaderProjection;
}

export interface BuiltPortableMarkdownExport {
  archiveName: string;
  archiveBytes: Uint8Array;
  fileCount: number;
  manifest: PortableMarkdownManifest;
}

export type PortableMarkdownUnavailableReason =
  | "reader-slots-not-materialized"
  | "unsupported-image-syntax"
  | "unsafe-asset-reference"
  | "missing-source-asset"
  | "fallback-assets-incomplete"
  | "portable-size-limit-exceeded"
  | "portable-archive-validation-failed";

export class PortableMarkdownUnavailableError extends Error {
  readonly reason: PortableMarkdownUnavailableReason;

  constructor(reason: PortableMarkdownUnavailableReason) {
    super(`Portable Markdown export is unavailable: ${reason}`);
    this.name = "PortableMarkdownUnavailableError";
    this.reason = reason;
  }
}

export class PortableMarkdownValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableMarkdownValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_EXTENSION = /\.(?:bmp|gif|jpe?g|png|webp)$/i;
const READER_SLOT = /<!--\s*p2md:slot\b/i;
const HTML_IMAGE = /^<img\s+src\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')\s*\/?\s*>$/is;
const SAFE_HTML_FORMATTING_TAG = /^<\/?(?:sup|sub|br|hr|wbr|b|strong|i|em|u|s|del|mark|small|kbd|code)\s*\/?\s*>$/i;
// Keep the comment whitelist deliberately narrower than the HTML tokenizer:
// no nested markup, double hyphen, or `--!>` alternate close is accepted.
const HTML_COMMENT = /^<!--(?:(?!--|[<>])[\s\S])*-->$/;
const PORTABLE_MARKDOWN = new MarkdownIt({ html: true, linkify: false, typographer: false });
// fflate turns Date fields into DOS timestamps. A local-time epoch is stable
// across timezones and remains inside the ZIP timestamp range.
const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);

class PortableReferenceError extends Error {
  readonly reason: "unsupported-image-syntax" | "unsafe-asset-reference";

  constructor(reason: "unsupported-image-syntax" | "unsafe-asset-reference") {
    super(reason);
    this.reason = reason;
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sortedExpected = [...expected].sort(compareCodeUnits);
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new PortableMarkdownValidationError(`${label} contains unknown or missing fields`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as UnknownRecord;
  return `{${Object.keys(item).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PortableMarkdownValidationError(`${label} is not valid UTF-8`);
  }
}

function normalizeImagePath(raw: string): string {
  let path: string;
  try {
    path = decodeURIComponent(raw.trim().replace(/^<|>$/g, ""));
  } catch {
    throw new PortableReferenceError("unsafe-asset-reference");
  }
  if (path.includes("\\")) throw new PortableReferenceError("unsafe-asset-reference");
  while (path.startsWith("./")) path = path.slice(2);
  if (!isSafeAfterMinerUPath(path) || !IMAGE_EXTENSION.test(path)) {
    throw new PortableReferenceError("unsafe-asset-reference");
  }
  return path;
}

type PortableMarkdownToken = ReturnType<MarkdownIt["parse"]>[number];

function imageReferences(markdown: string): string[] {
  const references: string[] = [];
  const visit = (tokens: readonly PortableMarkdownToken[]): void => {
    for (const token of tokens) {
      if (token.type === "image") {
        const source = token.attrGet("src");
        if (!source || /[()]/.test(source)) {
          throw new PortableReferenceError("unsupported-image-syntax");
        }
        references.push(normalizeImagePath(source));
      } else if (token.type === "html_inline" || token.type === "html_block") {
        const html = token.content.trim();
        if (!HTML_COMMENT.test(html) && !SAFE_HTML_FORMATTING_TAG.test(html)) {
          const htmlImage = HTML_IMAGE.exec(html);
          if (!htmlImage) throw new PortableReferenceError("unsupported-image-syntax");
          const source = htmlImage[1] || htmlImage[2] || "";
          if (source.includes("&")) throw new PortableReferenceError("unsupported-image-syntax");
          references.push(normalizeImagePath(source));
        }
      } else if (token.type === "text" && token.content.includes("![")) {
        // Invalid or policy-rejected image syntax remains text in MarkdownIt.
        // Reject it so another Markdown renderer cannot load an unbound asset.
        throw new PortableReferenceError("unsupported-image-syntax");
      }
      if (token.children) visit(token.children);
    }
  };
  visit(PORTABLE_MARKDOWN.parse(markdown, {}));
  return references;
}

function fileRecord(path: string, bytes: Uint8Array): AfterMinerUFileRecord {
  return { path, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function safeArchiveStem(name: string | undefined): string {
  const stem = (name ?? "paper")
    .replace(/(?:\.after-mineru|\.mineru)?\.zip$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "paper";
}

function parseFileRecord(value: unknown, label: string): AfterMinerUFileRecord {
  const item = record(value);
  if (!item) throw new PortableMarkdownValidationError(`${label} must be an object`);
  exactKeys(item, ["path", "size", "sha256"], label);
  const path = typeof item.path === "string" ? item.path : "";
  const size = Number(item.size);
  const sha256 = typeof item.sha256 === "string" ? item.sha256.toLocaleLowerCase("en-US") : "";
  if (
    !isSafeAfterMinerUPath(path)
    || !Number.isSafeInteger(size)
    || size < 1
    || size > AFTER_MINERU_PORTABLE_LIMITS.fileBytes
    || !SHA256.test(sha256)
  ) throw new PortableMarkdownValidationError(`${label} is invalid`);
  return { path, size, sha256 };
}

function parsePortableManifest(value: unknown): PortableMarkdownManifest {
  const manifest = record(value);
  if (!manifest) throw new PortableMarkdownValidationError("Portable Markdown manifest must be an object");
  exactKeys(manifest, [
    "schema_version",
    "contract",
    "algorithm_version",
    "source_archive_sha256",
    "representation",
    "article",
    "assets",
    "warnings"
  ], "Portable Markdown manifest");
  if (
    manifest.schema_version !== 1
    || manifest.contract !== AFTER_MINERU_PORTABLE_VERSION
    || typeof manifest.algorithm_version !== "string"
    || !manifest.algorithm_version.trim()
    || manifest.algorithm_version.length > 128
    || typeof manifest.source_archive_sha256 !== "string"
    || !SHA256.test(manifest.source_archive_sha256)
    || !["portable-derived", "source-assets-fallback"].includes(String(manifest.representation))
    || !Array.isArray(manifest.assets)
    || manifest.assets.length > AFTER_MINERU_PORTABLE_LIMITS.fileCount - 2
    || !Array.isArray(manifest.warnings)
  ) throw new PortableMarkdownValidationError("Portable Markdown manifest version or structure is unsupported");

  const article = parseFileRecord(manifest.article, "Portable Markdown article");
  if (article.path !== AFTER_MINERU_PORTABLE_ARTICLE_PATH) {
    throw new PortableMarkdownValidationError("Portable Markdown article path is invalid");
  }
  const assets = manifest.assets.map((entry, index) => parseFileRecord(entry, `Portable Markdown asset ${index}`));
  if (
    assets.some((entry) => !IMAGE_EXTENSION.test(entry.path))
    || assets.some((entry, index) => index > 0 && compareCodeUnits(assets[index - 1]!.path, entry.path) >= 0)
    || new Set(assets.map((entry) => canonicalPath(entry.path))).size !== assets.length
  ) throw new PortableMarkdownValidationError("Portable Markdown asset inventory is invalid or unsorted");

  const allowedWarnings = new Set<PortableMarkdownWarningCode>([
    "fragment-set-not-materialized",
    "pdf-crop-not-materialized"
  ]);
  const warnings = manifest.warnings.map((value, index) => {
    const warning = record(value);
    if (!warning) throw new PortableMarkdownValidationError(`Portable Markdown warning ${index} is invalid`);
    exactKeys(warning, ["code", "count"], `Portable Markdown warning ${index}`);
    const code = warning.code as PortableMarkdownWarningCode;
    const count = Number(warning.count);
    if (!allowedWarnings.has(code) || !Number.isSafeInteger(count) || count < 1) {
      throw new PortableMarkdownValidationError(`Portable Markdown warning ${index} is invalid`);
    }
    return { code, count };
  });
  if (
    warnings.some((entry, index) => index > 0 && compareCodeUnits(warnings[index - 1]!.code, entry.code) >= 0)
    || (warnings.length === 0) !== (manifest.representation === "portable-derived")
  ) throw new PortableMarkdownValidationError("Portable Markdown warnings and representation are inconsistent");

  return {
    schema_version: 1,
    contract: AFTER_MINERU_PORTABLE_VERSION,
    algorithm_version: manifest.algorithm_version,
    source_archive_sha256: manifest.source_archive_sha256,
    representation: manifest.representation as PortableMarkdownManifest["representation"],
    article,
    assets,
    warnings
  };
}

function readRequired(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (!bytes) throw new PortableMarkdownValidationError(`Portable Markdown file is missing: ${path}`);
  return bytes;
}

export function validatePortableMarkdownExport(
  files: ReadonlyMap<string, Uint8Array>
): PortableMarkdownManifest {
  const manifestBytes = readRequired(files, AFTER_MINERU_PORTABLE_MANIFEST_PATH);
  if (manifestBytes.byteLength > AFTER_MINERU_PACKAGE_LIMITS.manifestBytes) {
    throw new PortableMarkdownValidationError("Portable Markdown manifest exceeds the safe size limit");
  }
  let decodedManifest: unknown;
  try {
    decodedManifest = JSON.parse(decodeUtf8(manifestBytes, "Portable Markdown manifest")) as unknown;
  } catch (error) {
    if (error instanceof PortableMarkdownValidationError) throw error;
    throw new PortableMarkdownValidationError("Portable Markdown manifest is not valid JSON");
  }
  const manifest = parsePortableManifest(decodedManifest);
  const expectedPaths = [
    AFTER_MINERU_PORTABLE_MANIFEST_PATH,
    manifest.article.path,
    ...manifest.assets.map((entry) => entry.path)
  ];
  const actualPaths = [...files.keys()];
  if (
    actualPaths.length !== expectedPaths.length
    || actualPaths.some((path) => !isSafeAfterMinerUPath(path))
    || new Set(actualPaths.map(canonicalPath)).size !== actualPaths.length
    || expectedPaths.some((path) => !files.has(path))
    || actualPaths.some((path) => !expectedPaths.includes(path))
  ) throw new PortableMarkdownValidationError("Portable Markdown inventory is not exact");

  let totalBytes = manifestBytes.byteLength;
  for (const entry of [manifest.article, ...manifest.assets]) {
    const bytes = readRequired(files, entry.path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength !== entry.size || sha256Bytes(bytes) !== entry.sha256) {
      throw new PortableMarkdownValidationError(`Portable Markdown file does not match its manifest: ${entry.path}`);
    }
  }
  if (totalBytes > AFTER_MINERU_PORTABLE_LIMITS.totalBytes) {
    throw new PortableMarkdownValidationError("Portable Markdown export exceeds the aggregate size limit");
  }

  const article = decodeUtf8(readRequired(files, manifest.article.path), "Portable Markdown article");
  if (!article.trim() || READER_SLOT.test(article)) {
    throw new PortableMarkdownValidationError("Portable Markdown article is empty or contains a Reader-only slot");
  }
  let references: string[];
  try {
    references = imageReferences(article);
  } catch (error) {
    throw new PortableMarkdownValidationError(error instanceof Error ? error.message : String(error));
  }
  const uniqueReferences = [...new Set(references)].sort(compareCodeUnits);
  const assetPaths = manifest.assets.map((entry) => entry.path);
  if (
    uniqueReferences.length !== assetPaths.length
    || uniqueReferences.some((path, index) => path !== assetPaths[index])
  ) throw new PortableMarkdownValidationError("Portable Markdown image references do not match its asset inventory");
  return manifest;
}

export async function buildPortableMarkdownExport(
  input: BuildPortableMarkdownExportInput
): Promise<BuiltPortableMarkdownExport> {
  // Verification must precede every interpretation of caller-supplied package
  // metadata or derived Markdown.
  const verified = await validateAfterMinerUPackage(mapAfterMinerUPackageReader(input.verifiedPackageFiles));
  if (canonicalJson(input.manifest) !== canonicalJson(verified.manifest)) {
    throw new PortableMarkdownValidationError("Caller manifest does not match the verified package manifest");
  }
  if (canonicalJson(input.readerProjection) !== canonicalJson(verified.readerProjection)) {
    throw new PortableMarkdownValidationError("Caller Reader projection does not match the verified package projection");
  }

  const derivedBytes = input.verifiedPackageFiles.get(verified.manifest.derived.article_path)!;
  const article = decodeUtf8(derivedBytes, "After-MinerU derived article");
  if (READER_SLOT.test(article)) throw new PortableMarkdownUnavailableError("reader-slots-not-materialized");

  let references: string[];
  try {
    references = imageReferences(article);
  } catch (error) {
    throw new PortableMarkdownUnavailableError(
      error instanceof PortableReferenceError ? error.reason : "unsupported-image-syntax"
    );
  }
  const referencePaths = [...new Set(references)].sort(compareCodeUnits);
  if (referencePaths.length > AFTER_MINERU_PORTABLE_LIMITS.fileCount - 2) {
    throw new PortableMarkdownUnavailableError("portable-size-limit-exceeded");
  }
  const sourceRecords = new Map(verified.manifest.source.files
    .map((entry): [string, AfterMinerUFileRecord] => [entry.path, entry]));
  const aliasTargets = new Map(verified.manifest.compatibility.aliases
    .map((entry): [string, string] => [entry.path, entry.canonical_path]));
  const referenceTargets = new Set(referencePaths.map((path) => aliasTargets.get(path) ?? path));
  const portableAssetSources: Array<{ path: string; bytes: Uint8Array }> = [];
  let projectedTotalBytes = derivedBytes.byteLength;
  for (const path of referencePaths) {
    const target = aliasTargets.get(path) ?? path;
    const sourceRecord = sourceRecords.get(target);
    if (!target.startsWith("source/") || !sourceRecord) {
      throw new PortableMarkdownUnavailableError("missing-source-asset");
    }
    const bytes = input.verifiedPackageFiles.get(target);
    if (!bytes) throw new PortableMarkdownUnavailableError("missing-source-asset");
    projectedTotalBytes += sourceRecord.size;
    if (projectedTotalBytes > AFTER_MINERU_PORTABLE_LIMITS.totalBytes) {
      throw new PortableMarkdownUnavailableError("portable-size-limit-exceeded");
    }
    portableAssetSources.push({ path, bytes });
  }

  const warningCounts = new Map<PortableMarkdownWarningCode, number>();
  for (const visual of verified.readerProjection.visuals) {
    const target = (path: string): string => aliasTargets.get(path) ?? path;
    if (visual.display.mode === "asset") {
      if (!referenceTargets.has(target(visual.path))) {
        throw new PortableMarkdownUnavailableError("fallback-assets-incomplete");
      }
      continue;
    }
    const memberTargets = new Set(visual.member_asset_paths.map(target));
    if (memberTargets.size === 0 || [...memberTargets].some((path) => !referenceTargets.has(path))) {
      throw new PortableMarkdownUnavailableError("fallback-assets-incomplete");
    }
    const code: PortableMarkdownWarningCode = visual.display.mode === "pdf-crop"
      ? "pdf-crop-not-materialized"
      : "fragment-set-not-materialized";
    warningCounts.set(code, (warningCounts.get(code) ?? 0) + 1);
  }

  const articleBytes = derivedBytes.slice();
  const portableAssets = new Map(portableAssetSources.map(({ path, bytes }) => [path, bytes.slice()]));
  const files = new Map<string, Uint8Array>();
  files.set(AFTER_MINERU_PORTABLE_ARTICLE_PATH, articleBytes);
  for (const [path, bytes] of portableAssets) files.set(path, bytes);
  const warnings = [...warningCounts]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([code, count]) => ({ code, count }));
  const portableManifest: PortableMarkdownManifest = {
    schema_version: 1,
    contract: AFTER_MINERU_PORTABLE_VERSION,
    algorithm_version: verified.manifest.algorithm_version,
    source_archive_sha256: verified.validation.source_archive_sha256,
    representation: warnings.length ? "source-assets-fallback" : "portable-derived",
    article: fileRecord(AFTER_MINERU_PORTABLE_ARTICLE_PATH, articleBytes),
    assets: [...portableAssets].sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([path, bytes]) => fileRecord(path, bytes)),
    warnings
  };
  const portableManifestBytes = jsonBytes(portableManifest);
  if (
    portableManifestBytes.byteLength > AFTER_MINERU_PACKAGE_LIMITS.manifestBytes
    || projectedTotalBytes + portableManifestBytes.byteLength > AFTER_MINERU_PORTABLE_LIMITS.totalBytes
  ) throw new PortableMarkdownUnavailableError("portable-size-limit-exceeded");
  files.set(AFTER_MINERU_PORTABLE_MANIFEST_PATH, portableManifestBytes);
  let validatedManifest: PortableMarkdownManifest;
  try {
    validatedManifest = validatePortableMarkdownExport(files);
  } catch {
    throw new PortableMarkdownUnavailableError("portable-archive-validation-failed");
  }

  const entries = Object.create(null) as Zippable;
  for (const [path, bytes] of [...files].sort(([left], [right]) => compareCodeUnits(left, right))) {
    // Store portable entries without DEFLATE. The source package has already
    // passed byte limits and hashes; storing prevents a valid, repetitive
    // bitmap from becoming an archive that our own zip-bomb ratio guard rejects.
    entries[path] = [bytes, { level: 0, mtime: FIXED_ZIP_MTIME }];
  }
  const archiveBytes = zipSync(entries, { level: 0 });
  if (archiveBytes.byteLength > AFTER_MINERU_PORTABLE_LIMITS.archiveBytes) {
    throw new PortableMarkdownUnavailableError("portable-size-limit-exceeded");
  }
  try {
    const extracted = extractValidatedZipEntries(
      archiveBytes,
      AFTER_MINERU_PORTABLE_LIMITS,
      isSafeAfterMinerUPath,
      { allowDirectoryEntries: false }
    );
    validatePortableMarkdownExport(extracted);
  } catch {
    throw new PortableMarkdownUnavailableError("portable-archive-validation-failed");
  }
  return {
    archiveName: `${safeArchiveStem(input.archiveName)}.after-mineru-markdown.zip`,
    archiveBytes,
    fileCount: files.size,
    manifest: validatedManifest
  };
}
