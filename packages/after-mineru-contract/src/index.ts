import { sha256Bytes, sha256Utf8 } from "./sha256";
import {
  extractValidatedZipEntries,
  type SafeZipArchiveLimits,
  type SafeZipExtractionOptions
} from "./safe-zip";

export { sha256Bytes, sha256Utf8 };
export { extractValidatedZipEntries, type SafeZipArchiveLimits, type SafeZipExtractionOptions };

export const AFTER_MINERU_MANIFEST_PATH = "after-mineru.manifest.json";
export const AFTER_MINERU_PACKAGE_VERSION = "after-mineru-package-v1";
export const AFTER_MINERU_VALIDATION_VERSION = "after-mineru-validation-v1";
export const AFTER_MINERU_READER_PROJECTION_VERSION = "after-mineru-reader-projection-v1";
export const AFTER_MINERU_PROVENANCE_VERSION = "after-mineru-provenance-v1";
export const AFTER_MINERU_REPAIR_ALGORITHM_VERSION = "after-mineru-visual-repair-v1";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AFTER_MINERU_PACKAGE_LIMITS = Object.freeze({
  compressedArchiveBytes: 384 * 1024 * 1024,
  archiveFileCount: 2_048,
  fileBytes: 64 * 1024 * 1024,
  articleBytes: 32 * 1024 * 1024,
  manifestBytes: 512 * 1024,
  validationBytes: 256 * 1024,
  provenanceBytes: 256 * 1024,
  projectionBytes: 16 * 1024 * 1024,
  fileRecords: 4_096,
  totalBytes: 768 * 1024 * 1024,
  compressionRatio: 200,
  pathDepth: 24
});
const MAX_MANIFEST_BYTES = AFTER_MINERU_PACKAGE_LIMITS.manifestBytes;
const MAX_VALIDATION_BYTES = AFTER_MINERU_PACKAGE_LIMITS.validationBytes;
const MAX_PROVENANCE_BYTES = AFTER_MINERU_PACKAGE_LIMITS.provenanceBytes;
const MAX_PROJECTION_BYTES = AFTER_MINERU_PACKAGE_LIMITS.projectionBytes;
const MAX_FILE_RECORDS = AFTER_MINERU_PACKAGE_LIMITS.fileRecords;
const MAX_PACKAGE_BYTES = AFTER_MINERU_PACKAGE_LIMITS.totalBytes;
const MAX_FILE_BYTES = AFTER_MINERU_PACKAGE_LIMITS.fileBytes;
const MAX_VISUALS = 2048;
export const AFTER_MINERU_SOURCE_ARCHIVE_LIMITS: Readonly<SafeZipArchiveLimits> = Object.freeze({
  archiveBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  fileCount: 512,
  fileBytes: AFTER_MINERU_PACKAGE_LIMITS.fileBytes,
  totalBytes: 256 * 1024 * 1024,
  compressionRatio: AFTER_MINERU_PACKAGE_LIMITS.compressionRatio,
  pathDepth: 16
});

type UnknownRecord = Record<string, unknown>;

export interface AfterMinerUFileRecord {
  path: string;
  size: number;
  sha256: string;
}

export interface AfterMinerUCompatibilityAlias extends AfterMinerUFileRecord {
  canonical_path: string;
}

export interface AfterMinerUManifest {
  schema_version: typeof AFTER_MINERU_PACKAGE_VERSION;
  algorithm_version: string;
  source: {
    archive_path: string;
    article_path: string;
    content_list_path: string;
    pdf_path: string | null;
    files: AfterMinerUFileRecord[];
  };
  derived: {
    article_path: string;
    files: AfterMinerUFileRecord[];
  };
  sidecars: {
    reader_projection_path: string;
    viewer_index_path: string;
    visual_repair_path: string;
    visual_candidates_path: string;
    display_repair_path: string | null;
    provenance_path: string;
    validation_path: string;
    files: AfterMinerUFileRecord[];
  };
  compatibility: {
    profile: "paper2md-reader-v0.1.3";
    aliases: AfterMinerUCompatibilityAlias[];
  };
}

export interface AfterMinerUValidation {
  schema_version: typeof AFTER_MINERU_VALIDATION_VERSION;
  status: "passed";
  algorithm_version: string;
  source_archive_sha256: string;
  checks: {
    source_bytes_preserved: true;
    derived_article_bound: true;
    sidecars_bound: true;
    compatibility_aliases_bound: true;
  };
  summary: {
    source_file_count: number;
    derived_file_count: number;
    sidecar_file_count: number;
    compatibility_alias_count: number;
    repaired_visual_count: number;
    review_candidate_count: number;
    unresolved_text_replacement_count: number;
  };
}

export interface AfterMinerUProvenance {
  schema_version: 1;
  contract: typeof AFTER_MINERU_PROVENANCE_VERSION;
  algorithm_version: string;
  source_archive: AfterMinerUFileRecord;
  source_pdf: AfterMinerUFileRecord | null;
  source_pdf_origin: "archive-entry" | "explicit-selection" | null;
  source_entry_count: number;
  source_tree: {
    root_prefix: string;
    entries: AfterMinerUSourceEntryBinding[];
  };
  derived_article: AfterMinerUFileRecord;
  guarantees: string[];
}

export interface AfterMinerUSourceEntryBinding {
  archive_path: string;
  package_path: string;
  size: number;
  sha256: string;
}

export interface AfterMinerUNormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AfterMinerUVisualDisplay =
  | { mode: "asset" }
  | { mode: "pdf-crop"; pdf_path: string; bbox: AfterMinerUNormalizedBBox; padding: number }
  | { mode: "fragment-set"; fragments: Array<{ path: string; bbox: AfterMinerUNormalizedBBox }> };

export interface AfterMinerUProjectedVisual {
  id: string;
  kind: "figure" | "table" | "equation" | "unknown";
  path: string;
  label: string;
  caption_text: string | null;
  page_index: number | null;
  placement_block_id: string | null;
  source_bbox: AfterMinerUNormalizedBBox | null;
  member_asset_paths: string[];
  member_block_ids: string[];
  caption_page_index: number | null;
  caption_status: "complete" | "partial" | null;
  display: AfterMinerUVisualDisplay;
}

export interface AfterMinerUReaderProjection {
  schema_version: 1;
  contract: typeof AFTER_MINERU_READER_PROJECTION_VERSION;
  inputs: {
    source_article: AfterMinerUFileRecord;
    source_content_list: AfterMinerUFileRecord;
    derived_article: AfterMinerUFileRecord;
  };
  visuals: AfterMinerUProjectedVisual[];
  summary: {
    visual_count: number;
    repaired_visual_count: number;
    hidden_visual_count: number;
    review_candidate_count: number;
    unresolved_text_replacement_count: number;
  };
}

export interface AfterMinerUPackageReader {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array>;
  fileInfo?(path: string): Promise<{ size: number } | undefined>;
  /**
   * Complete package inventory. Formal Map/ZIP adapters provide this so the
   * validator can reject unmanifested files. Directory adapters that cannot
   * recursively and atomically enumerate may omit it; consumers must then
   * expose only manifest-bound files.
   */
  enumeratePaths?(): Promise<readonly string[]>;
}

export interface VerifiedAfterMinerUPackage {
  manifest: AfterMinerUManifest;
  validation: AfterMinerUValidation;
  provenance: AfterMinerUProvenance;
  readerProjection: AfterMinerUReaderProjection;
  records: ReadonlyMap<string, AfterMinerUFileRecord>;
}

export class AfterMinerUPackageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AfterMinerUPackageValidationError";
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AfterMinerUPackageValidationError(`${label} contains unknown or missing fields`);
  }
}

function canonicalPath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function isSafeAfterMinerUPath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.length <= 24 && segments.every((segment) => (
    Boolean(segment)
    && segment !== "."
    && segment !== ".."
    && segment.length <= 255
    && !/[\u0000-\u001f<>:"|?*#]/u.test(segment)
    && !/[. ]$/u.test(segment)
    && !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    && !/^(?:__proto__|constructor|prototype)$/iu.test(segment)
  ));
}

function parseFileRecord(value: unknown, label: string): AfterMinerUFileRecord {
  const item = record(value);
  if (!item) throw new AfterMinerUPackageValidationError(`${label} must be an object`);
  exactKeys(item, ["path", "size", "sha256"], label);
  const path = typeof item.path === "string" ? item.path : "";
  const size = Number(item.size);
  const hash = typeof item.sha256 === "string" ? item.sha256.toLocaleLowerCase() : "";
  if (!isSafeAfterMinerUPath(path) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES || !SHA256.test(hash)) {
    throw new AfterMinerUPackageValidationError(`${label} is invalid`);
  }
  return { path, size, sha256: hash };
}

function parseFileRecords(value: unknown, prefix: string, label: string): AfterMinerUFileRecord[] {
  if (!Array.isArray(value) || value.length > MAX_FILE_RECORDS) {
    throw new AfterMinerUPackageValidationError(`${label} file list is invalid`);
  }
  const canonical = new Set<string>();
  return value.map((item, index) => {
    const entry = parseFileRecord(item, `${label}[${index}]`);
    if (!entry.path.startsWith(prefix) || canonical.has(canonicalPath(entry.path))) {
      throw new AfterMinerUPackageValidationError(`${label} contains an invalid or conflicting path: ${entry.path}`);
    }
    canonical.add(canonicalPath(entry.path));
    return entry;
  });
}

function requiredPath(value: unknown, prefix: string, label: string): string {
  const path = typeof value === "string" ? value : "";
  if (!isSafeAfterMinerUPath(path) || !path.startsWith(prefix)) {
    throw new AfterMinerUPackageValidationError(`${label} is invalid`);
  }
  return path;
}

function optionalPath(value: unknown, prefix: string, label: string): string | null {
  return value === null ? null : requiredPath(value, prefix, label);
}

export function parseAfterMinerUManifest(value: unknown): AfterMinerUManifest {
  const manifest = record(value);
  if (!manifest) throw new AfterMinerUPackageValidationError("After-MinerU manifest must be an object");
  exactKeys(manifest, ["schema_version", "algorithm_version", "source", "derived", "sidecars", "compatibility"], "After-MinerU manifest");
  if (manifest.schema_version !== AFTER_MINERU_PACKAGE_VERSION || typeof manifest.algorithm_version !== "string" || !SAFE_ID.test(manifest.algorithm_version)) {
    throw new AfterMinerUPackageValidationError("After-MinerU manifest version or algorithm is unsupported");
  }

  const source = record(manifest.source);
  const derived = record(manifest.derived);
  const sidecars = record(manifest.sidecars);
  const compatibility = record(manifest.compatibility);
  if (!source || !derived || !sidecars || !compatibility) {
    throw new AfterMinerUPackageValidationError("After-MinerU manifest sections are missing");
  }
  exactKeys(source, ["archive_path", "article_path", "content_list_path", "pdf_path", "files"], "manifest.source");
  exactKeys(derived, ["article_path", "files"], "manifest.derived");
  exactKeys(sidecars, [
    "reader_projection_path",
    "viewer_index_path",
    "visual_repair_path",
    "visual_candidates_path",
    "display_repair_path",
    "provenance_path",
    "validation_path",
    "files"
  ], "manifest.sidecars");
  exactKeys(compatibility, ["profile", "aliases"], "manifest.compatibility");

  const sourceFiles = parseFileRecords(source.files, "source/", "manifest.source.files");
  const derivedFiles = parseFileRecords(derived.files, "derived/", "manifest.derived.files");
  const sidecarFiles = parseFileRecords(sidecars.files, "sidecars/", "manifest.sidecars.files");
  const byPath = new Map([...sourceFiles, ...derivedFiles, ...sidecarFiles].map((entry) => [entry.path, entry]));
  const archivePath = requiredPath(source.archive_path, "source/", "manifest.source.archive_path");
  const sourceArticlePath = requiredPath(source.article_path, "source/", "manifest.source.article_path");
  const sourceContentListPath = requiredPath(source.content_list_path, "source/", "manifest.source.content_list_path");
  const sourcePdfPath = optionalPath(source.pdf_path, "source/", "manifest.source.pdf_path");
  const derivedArticlePath = requiredPath(derived.article_path, "derived/", "manifest.derived.article_path");
  const readerProjectionPath = requiredPath(sidecars.reader_projection_path, "sidecars/", "manifest.sidecars.reader_projection_path");
  const viewerIndexPath = requiredPath(sidecars.viewer_index_path, "sidecars/", "manifest.sidecars.viewer_index_path");
  const visualRepairPath = requiredPath(sidecars.visual_repair_path, "sidecars/", "manifest.sidecars.visual_repair_path");
  const visualCandidatesPath = requiredPath(sidecars.visual_candidates_path, "sidecars/", "manifest.sidecars.visual_candidates_path");
  const displayRepairPath = optionalPath(sidecars.display_repair_path, "sidecars/", "manifest.sidecars.display_repair_path");
  const provenancePath = requiredPath(sidecars.provenance_path, "sidecars/", "manifest.sidecars.provenance_path");
  const validationPath = requiredPath(sidecars.validation_path, "sidecars/", "manifest.sidecars.validation_path");
  const sourceRolePaths = [archivePath, sourceArticlePath, sourceContentListPath, sourcePdfPath]
    .filter((path): path is string => path !== null);
  if (new Set(sourceRolePaths.map(canonicalPath)).size !== sourceRolePaths.length) {
    throw new AfterMinerUPackageValidationError("After-MinerU source roles must reference distinct files");
  }
  const sidecarRolePaths = [
    readerProjectionPath,
    viewerIndexPath,
    visualRepairPath,
    visualCandidatesPath,
    displayRepairPath,
    provenancePath,
    validationPath
  ].filter((path): path is string => path !== null);
  if (new Set(sidecarRolePaths.map(canonicalPath)).size !== sidecarRolePaths.length) {
    throw new AfterMinerUPackageValidationError("After-MinerU sidecar roles must reference distinct files");
  }
  for (const [path, label] of [
    [archivePath, "source archive"],
    [sourceArticlePath, "source article"],
    [sourceContentListPath, "source content list"],
    [sourcePdfPath, "source PDF"],
    [derivedArticlePath, "derived article"],
    [readerProjectionPath, "Reader projection"],
    [viewerIndexPath, "viewer index"],
    [visualRepairPath, "visual repair"],
    [visualCandidatesPath, "visual candidates"],
    [displayRepairPath, "display repair"],
    [provenancePath, "provenance"],
    [validationPath, "validation"]
  ] as const) {
    if (path !== null && !byPath.has(path)) throw new AfterMinerUPackageValidationError(`Manifest does not bind the ${label}: ${path}`);
  }
  const assertRoleLimit = (path: string | null, limit: number, label: string): void => {
    if (path !== null && byPath.get(path)!.size > limit) {
      throw new AfterMinerUPackageValidationError(`${label} exceeds the safe size limit`);
    }
  };
  assertRoleLimit(archivePath, MAX_FILE_BYTES, "source archive");
  assertRoleLimit(sourceArticlePath, AFTER_MINERU_PACKAGE_LIMITS.articleBytes, "source article");
  assertRoleLimit(sourceContentListPath, AFTER_MINERU_PACKAGE_LIMITS.articleBytes, "source content list");
  assertRoleLimit(sourcePdfPath, MAX_FILE_BYTES, "source PDF");
  assertRoleLimit(derivedArticlePath, AFTER_MINERU_PACKAGE_LIMITS.articleBytes, "derived article");
  assertRoleLimit(readerProjectionPath, MAX_PROJECTION_BYTES, "Reader projection");
  assertRoleLimit(viewerIndexPath, MAX_PROJECTION_BYTES, "viewer index");
  assertRoleLimit(visualRepairPath, MAX_PROJECTION_BYTES, "visual repair");
  assertRoleLimit(visualCandidatesPath, MAX_PROJECTION_BYTES, "visual candidates");
  assertRoleLimit(displayRepairPath, MAX_PROJECTION_BYTES, "display repair");
  assertRoleLimit(provenancePath, MAX_PROVENANCE_BYTES, "provenance");
  assertRoleLimit(validationPath, MAX_VALIDATION_BYTES, "validation");

  if (compatibility.profile !== "paper2md-reader-v0.1.3" || !Array.isArray(compatibility.aliases) || compatibility.aliases.length > MAX_FILE_RECORDS) {
    throw new AfterMinerUPackageValidationError("After-MinerU compatibility profile is invalid");
  }
  const aliasCanonical = new Set<string>();
  const aliases = compatibility.aliases.map((value, index): AfterMinerUCompatibilityAlias => {
    const item = record(value);
    if (!item) throw new AfterMinerUPackageValidationError(`compatibility alias ${index} must be an object`);
    exactKeys(item, ["path", "canonical_path", "size", "sha256"], `compatibility alias ${index}`);
    const file = parseFileRecord({ path: item.path, size: item.size, sha256: item.sha256 }, `compatibility alias ${index}`);
    const canonicalTarget = typeof item.canonical_path === "string" ? item.canonical_path : "";
    const target = byPath.get(canonicalTarget);
    if (
      !target
      || aliasCanonical.has(canonicalPath(file.path))
      || [...byPath.keys()].some((path) => canonicalPath(path) === canonicalPath(file.path))
      || target.size !== file.size
      || target.sha256 !== file.sha256
    ) {
      throw new AfterMinerUPackageValidationError(`Compatibility alias is conflicting or not hash-bound: ${file.path}`);
    }
    aliasCanonical.add(canonicalPath(file.path));
    return { ...file, canonical_path: canonicalTarget };
  });
  const requiredAlias = (path: string, canonicalTarget: string): void => {
    if (!aliases.some((entry) => entry.path === path && entry.canonical_path === canonicalTarget)) {
      throw new AfterMinerUPackageValidationError(`Paper2MD Reader v0.1.3 compatibility alias is missing or misbound: ${path}`);
    }
  };
  for (const entry of sourceFiles) {
    if (entry.path === archivePath || (entry.path === sourcePdfPath && entry.path === "source/source.pdf")) continue;
    requiredAlias(entry.path.slice("source/".length), entry.path);
  }
  requiredAlias("article.md", sourceArticlePath);
  requiredAlias("mineru-result.json", sourceContentListPath);
  requiredAlias("_source/mineru-original.mineru.zip", archivePath);
  requiredAlias("_extraction/viewer-index.json", viewerIndexPath);
  requiredAlias("_extraction/visual-repair.json", visualRepairPath);
  requiredAlias("_extraction/visual-candidates.json", visualCandidatesPath);
  requiredAlias("_extraction/manifest.json", "sidecars/paper2md-v0.1.3-manifest.json");
  requiredAlias("_extraction/validation.json", "sidecars/paper2md-v0.1.3-validation.json");
  if (sourcePdfPath) requiredAlias("_extraction/source.pdf", sourcePdfPath);

  return {
    schema_version: AFTER_MINERU_PACKAGE_VERSION,
    algorithm_version: manifest.algorithm_version,
    source: {
      archive_path: archivePath,
      article_path: sourceArticlePath,
      content_list_path: sourceContentListPath,
      pdf_path: sourcePdfPath,
      files: sourceFiles
    },
    derived: { article_path: derivedArticlePath, files: derivedFiles },
    sidecars: {
      reader_projection_path: readerProjectionPath,
      viewer_index_path: viewerIndexPath,
      visual_repair_path: visualRepairPath,
      visual_candidates_path: visualCandidatesPath,
      display_repair_path: displayRepairPath,
      provenance_path: provenancePath,
      validation_path: validationPath,
      files: sidecarFiles
    },
    compatibility: { profile: "paper2md-reader-v0.1.3", aliases }
  };
}

function nonnegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AfterMinerUPackageValidationError(`${label} must be a non-negative integer`);
  return number;
}

export function parseAfterMinerUValidation(value: unknown, manifest: AfterMinerUManifest): AfterMinerUValidation {
  const validation = record(value);
  if (!validation) throw new AfterMinerUPackageValidationError("After-MinerU validation must be an object");
  exactKeys(validation, ["schema_version", "status", "algorithm_version", "source_archive_sha256", "checks", "summary"], "After-MinerU validation");
  const checks = record(validation.checks);
  const summary = record(validation.summary);
  if (!checks || !summary) throw new AfterMinerUPackageValidationError("After-MinerU validation sections are missing");
  exactKeys(checks, ["source_bytes_preserved", "derived_article_bound", "sidecars_bound", "compatibility_aliases_bound"], "validation.checks");
  exactKeys(summary, [
    "source_file_count",
    "derived_file_count",
    "sidecar_file_count",
    "compatibility_alias_count",
    "repaired_visual_count",
    "review_candidate_count",
    "unresolved_text_replacement_count"
  ], "validation.summary");
  const archive = manifest.source.files.find((entry) => entry.path === manifest.source.archive_path);
  if (
    validation.schema_version !== AFTER_MINERU_VALIDATION_VERSION
    || validation.status !== "passed"
    || validation.algorithm_version !== manifest.algorithm_version
    || validation.source_archive_sha256 !== archive?.sha256
    || Object.values(checks).some((item) => item !== true)
  ) {
    throw new AfterMinerUPackageValidationError("After-MinerU validation did not pass or does not match the manifest");
  }
  const parsedSummary = {
    source_file_count: nonnegativeInteger(summary.source_file_count, "validation.summary.source_file_count"),
    derived_file_count: nonnegativeInteger(summary.derived_file_count, "validation.summary.derived_file_count"),
    sidecar_file_count: nonnegativeInteger(summary.sidecar_file_count, "validation.summary.sidecar_file_count"),
    compatibility_alias_count: nonnegativeInteger(summary.compatibility_alias_count, "validation.summary.compatibility_alias_count"),
    repaired_visual_count: nonnegativeInteger(summary.repaired_visual_count, "validation.summary.repaired_visual_count"),
    review_candidate_count: nonnegativeInteger(summary.review_candidate_count, "validation.summary.review_candidate_count"),
    unresolved_text_replacement_count: nonnegativeInteger(summary.unresolved_text_replacement_count, "validation.summary.unresolved_text_replacement_count")
  };
  if (
    parsedSummary.source_file_count !== manifest.source.files.length
    || parsedSummary.derived_file_count !== manifest.derived.files.length
    || parsedSummary.sidecar_file_count !== manifest.sidecars.files.length
    || parsedSummary.compatibility_alias_count !== manifest.compatibility.aliases.length
  ) throw new AfterMinerUPackageValidationError("After-MinerU validation counts do not match the manifest");
  return {
    schema_version: AFTER_MINERU_VALIDATION_VERSION,
    status: "passed",
    algorithm_version: manifest.algorithm_version,
    source_archive_sha256: validation.source_archive_sha256 as string,
    checks: {
      source_bytes_preserved: true,
      derived_article_bound: true,
      sidecars_bound: true,
      compatibility_aliases_bound: true
    },
    summary: parsedSummary
  };
}

function sameFileRecord(left: AfterMinerUFileRecord, right: AfterMinerUFileRecord): boolean {
  return left.path === right.path && left.size === right.size && left.sha256 === right.sha256;
}

function parseSourceTree(
  value: unknown,
  manifest: AfterMinerUManifest,
  sourcePdfOrigin: AfterMinerUProvenance["source_pdf_origin"]
): AfterMinerUProvenance["source_tree"] {
  const tree = record(value);
  if (!tree) throw new AfterMinerUPackageValidationError("provenance.source_tree must be an object");
  exactKeys(tree, ["root_prefix", "entries"], "provenance.source_tree");
  const rootPrefix = typeof tree.root_prefix === "string" ? tree.root_prefix : "";
  if (
    rootPrefix !== ""
    && (!rootPrefix.endsWith("/") || !isSafeAfterMinerUPath(rootPrefix.slice(0, -1)))
  ) throw new AfterMinerUPackageValidationError("provenance.source_tree.root_prefix is invalid");
  if (!Array.isArray(tree.entries) || tree.entries.length > AFTER_MINERU_PACKAGE_LIMITS.archiveFileCount) {
    throw new AfterMinerUPackageValidationError("provenance.source_tree.entries is invalid");
  }
  const sourceRecords = new Map(manifest.source.files.map((entry) => [entry.path, entry]));
  const archiveCanonical = new Set<string>();
  const packageCanonical = new Set<string>();
  const entries = tree.entries.map((value, index): AfterMinerUSourceEntryBinding => {
    const item = record(value);
    if (!item) throw new AfterMinerUPackageValidationError(`provenance.source_tree.entries[${index}] must be an object`);
    exactKeys(item, ["archive_path", "package_path", "size", "sha256"], `provenance.source_tree.entries[${index}]`);
    const archiveRecord = parseFileRecord(
      { path: item.archive_path, size: item.size, sha256: item.sha256 },
      `provenance.source_tree.entries[${index}].archive`
    );
    const packagePath = typeof item.package_path === "string" ? item.package_path : "";
    const packageRecord = sourceRecords.get(packagePath);
    const relativePath = archiveRecord.path.startsWith(rootPrefix)
      ? archiveRecord.path.slice(rootPrefix.length)
      : "";
    const archiveKey = canonicalPath(archiveRecord.path);
    const packageKey = canonicalPath(packagePath);
    if (
      !relativePath
      || packagePath !== `source/${relativePath}`
      || !packageRecord
      || packageRecord.size !== archiveRecord.size
      || packageRecord.sha256 !== archiveRecord.sha256
      || archiveCanonical.has(archiveKey)
      || packageCanonical.has(packageKey)
    ) {
      throw new AfterMinerUPackageValidationError(
        `provenance source-tree entry is conflicting, unbound, or outside its root: ${archiveRecord.path}`
      );
    }
    archiveCanonical.add(archiveKey);
    packageCanonical.add(packageKey);
    return {
      archive_path: archiveRecord.path,
      package_path: packagePath,
      size: archiveRecord.size,
      sha256: archiveRecord.sha256
    };
  });
  const expectedPackagePaths = manifest.source.files
    .filter((entry) => (
      entry.path !== manifest.source.archive_path
      && !(sourcePdfOrigin === "explicit-selection" && entry.path === manifest.source.pdf_path)
    ))
    .map((entry) => entry.path)
    .sort();
  const actualPackagePaths = entries.map((entry) => entry.package_path).sort();
  if (
    expectedPackagePaths.length !== actualPackagePaths.length
    || expectedPackagePaths.some((path, index) => path !== actualPackagePaths[index])
  ) {
    throw new AfterMinerUPackageValidationError("provenance source tree does not exactly bind every original archive entry");
  }
  if (
    sourcePdfOrigin === "archive-entry"
    && !entries.some((entry) => entry.package_path === manifest.source.pdf_path)
  ) throw new AfterMinerUPackageValidationError("embedded source PDF is not bound by the provenance source tree");
  if (
    sourcePdfOrigin === "explicit-selection"
    && entries.some((entry) => entry.package_path === manifest.source.pdf_path)
  ) throw new AfterMinerUPackageValidationError("explicit source PDF must not appear in the provenance source tree");
  return { root_prefix: rootPrefix, entries };
}

export function parseAfterMinerUProvenance(value: unknown, manifest: AfterMinerUManifest): AfterMinerUProvenance {
  const provenance = record(value);
  if (!provenance) throw new AfterMinerUPackageValidationError("After-MinerU provenance must be an object");
  exactKeys(provenance, [
    "schema_version",
    "contract",
    "algorithm_version",
    "source_archive",
    "source_pdf",
    "source_pdf_origin",
    "source_entry_count",
    "source_tree",
    "derived_article",
    "guarantees"
  ], "After-MinerU provenance");
  if (
    provenance.schema_version !== 1
    || provenance.contract !== AFTER_MINERU_PROVENANCE_VERSION
    || provenance.algorithm_version !== manifest.algorithm_version
  ) throw new AfterMinerUPackageValidationError("After-MinerU provenance version or algorithm is unsupported");

  const sourceArchive = parseFileRecord(provenance.source_archive, "provenance.source_archive");
  const derivedArticle = parseFileRecord(provenance.derived_article, "provenance.derived_article");
  const expectedArchive = manifest.source.files.find((entry) => entry.path === manifest.source.archive_path)!;
  const expectedArticle = manifest.derived.files.find((entry) => entry.path === manifest.derived.article_path)!;
  if (!sameFileRecord(sourceArchive, expectedArchive) || !sameFileRecord(derivedArticle, expectedArticle)) {
    throw new AfterMinerUPackageValidationError("After-MinerU provenance is not bound to the manifest source and derived article");
  }

  let sourcePdf: AfterMinerUFileRecord | null = null;
  if (provenance.source_pdf !== null) sourcePdf = parseFileRecord(provenance.source_pdf, "provenance.source_pdf");
  const expectedPdf = manifest.source.pdf_path
    ? manifest.source.files.find((entry) => entry.path === manifest.source.pdf_path)!
    : null;
  if ((sourcePdf === null) !== (expectedPdf === null) || (sourcePdf && expectedPdf && !sameFileRecord(sourcePdf, expectedPdf))) {
    throw new AfterMinerUPackageValidationError("After-MinerU provenance source PDF does not match the manifest");
  }

  const sourcePdfOrigin = provenance.source_pdf_origin;
  if (
    ![null, "archive-entry", "explicit-selection"].includes(sourcePdfOrigin as null | string)
    || (sourcePdf === null && sourcePdfOrigin !== null)
    || (sourcePdf !== null && sourcePdfOrigin === null)
    || (sourcePdfOrigin === "explicit-selection" && manifest.source.pdf_path !== "source/source.pdf")
    || (sourcePdfOrigin === "archive-entry" && manifest.source.pdf_path === "source/source.pdf")
  ) throw new AfterMinerUPackageValidationError("After-MinerU provenance source PDF origin is inconsistent");

  const sourceEntryCount = nonnegativeInteger(provenance.source_entry_count, "provenance.source_entry_count");
  const sourceTree = parseSourceTree(provenance.source_tree, manifest, sourcePdfOrigin as AfterMinerUProvenance["source_pdf_origin"]);
  if (sourceEntryCount !== sourceTree.entries.length) {
    throw new AfterMinerUPackageValidationError("After-MinerU provenance source entry count does not match the manifest");
  }
  if (
    !Array.isArray(provenance.guarantees)
    || provenance.guarantees.length < 1
    || provenance.guarantees.length > 16
    || provenance.guarantees.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_000)
  ) throw new AfterMinerUPackageValidationError("After-MinerU provenance guarantees are invalid");
  return {
    schema_version: 1,
    contract: AFTER_MINERU_PROVENANCE_VERSION,
    algorithm_version: manifest.algorithm_version,
    source_archive: sourceArchive,
    source_pdf: sourcePdf,
    source_pdf_origin: sourcePdfOrigin as AfterMinerUProvenance["source_pdf_origin"],
    source_entry_count: sourceEntryCount,
    source_tree: sourceTree,
    derived_article: derivedArticle,
    guarantees: [...provenance.guarantees] as string[]
  };
}

function normalizedBbox(value: unknown, label: string): AfterMinerUNormalizedBBox {
  const bbox = record(value);
  if (!bbox) throw new AfterMinerUPackageValidationError(`${label} must be an object`);
  exactKeys(bbox, ["x", "y", "width", "height"], label);
  const result = {
    x: Number(bbox.x),
    y: Number(bbox.y),
    width: Number(bbox.width),
    height: Number(bbox.height)
  };
  if (
    Object.values(result).some((item) => !Number.isFinite(item) || item < 0 || item > 1)
    || result.width <= 0
    || result.height <= 0
    || result.x + result.width > 1 + 1e-9
    || result.y + result.height > 1 + 1e-9
  ) throw new AfterMinerUPackageValidationError(`${label} is outside the normalized page`);
  return result;
}

function safeStringArray(value: unknown, label: string, pathValues = false): string[] {
  if (!Array.isArray(value) || value.length > MAX_VISUALS) throw new AfterMinerUPackageValidationError(`${label} is invalid`);
  const result = value.map((item) => typeof item === "string" ? item : "");
  if (
    result.some((item) => !item || (pathValues ? !isSafeAfterMinerUPath(item) : !SAFE_ID.test(item)))
    || new Set(result.map((item) => pathValues ? canonicalPath(item) : item)).size !== result.length
  ) throw new AfterMinerUPackageValidationError(`${label} contains invalid or duplicate values`);
  return result;
}

function parseDisplay(value: unknown, label: string): AfterMinerUVisualDisplay {
  const display = record(value);
  if (!display || typeof display.mode !== "string") throw new AfterMinerUPackageValidationError(`${label} is invalid`);
  if (display.mode === "asset") {
    exactKeys(display, ["mode"], label);
    return { mode: "asset" };
  }
  if (display.mode === "pdf-crop") {
    exactKeys(display, ["mode", "pdf_path", "bbox", "padding"], label);
    const pdfPath = typeof display.pdf_path === "string" ? display.pdf_path : "";
    const padding = Number(display.padding);
    if (!isSafeAfterMinerUPath(pdfPath) || !Number.isFinite(padding) || padding < 0 || padding > 0.05) {
      throw new AfterMinerUPackageValidationError(`${label} PDF crop is invalid`);
    }
    return { mode: "pdf-crop", pdf_path: pdfPath, bbox: normalizedBbox(display.bbox, `${label}.bbox`), padding };
  }
  if (display.mode === "fragment-set") {
    exactKeys(display, ["mode", "fragments"], label);
    if (!Array.isArray(display.fragments) || display.fragments.length < 1 || display.fragments.length > MAX_VISUALS) {
      throw new AfterMinerUPackageValidationError(`${label} fragment list is invalid`);
    }
    const fragments = display.fragments.map((value, index) => {
      const fragment = record(value);
      if (!fragment) throw new AfterMinerUPackageValidationError(`${label}.fragments[${index}] is invalid`);
      exactKeys(fragment, ["path", "bbox"], `${label}.fragments[${index}]`);
      const path = typeof fragment.path === "string" ? fragment.path : "";
      if (!isSafeAfterMinerUPath(path)) throw new AfterMinerUPackageValidationError(`${label}.fragments[${index}].path is invalid`);
      return { path, bbox: normalizedBbox(fragment.bbox, `${label}.fragments[${index}].bbox`) };
    });
    if (new Set(fragments.map((fragment) => canonicalPath(fragment.path))).size !== fragments.length) {
      throw new AfterMinerUPackageValidationError(`${label} fragments contain conflicting paths`);
    }
    return { mode: "fragment-set", fragments };
  }
  throw new AfterMinerUPackageValidationError(`${label} mode is unsupported`);
}

export function parseAfterMinerUReaderProjection(
  value: unknown,
  manifest: AfterMinerUManifest
): AfterMinerUReaderProjection {
  const projection = record(value);
  if (!projection) throw new AfterMinerUPackageValidationError("After-MinerU Reader projection must be an object");
  exactKeys(projection, ["schema_version", "contract", "inputs", "visuals", "summary"], "Reader projection");
  const inputs = record(projection.inputs);
  const summary = record(projection.summary);
  if (
    projection.schema_version !== 1
    || projection.contract !== AFTER_MINERU_READER_PROJECTION_VERSION
    || !inputs
    || !summary
    || !Array.isArray(projection.visuals)
    || projection.visuals.length > MAX_VISUALS
  ) throw new AfterMinerUPackageValidationError("After-MinerU Reader projection version or structure is unsupported");
  exactKeys(inputs, ["source_article", "source_content_list", "derived_article"], "Reader projection inputs");
  exactKeys(summary, [
    "visual_count",
    "repaired_visual_count",
    "hidden_visual_count",
    "review_candidate_count",
    "unresolved_text_replacement_count"
  ], "Reader projection summary");
  const sourceArticle = parseFileRecord(inputs.source_article, "Reader projection source article");
  const sourceContentList = parseFileRecord(inputs.source_content_list, "Reader projection source content list");
  const derivedArticle = parseFileRecord(inputs.derived_article, "Reader projection derived article");
  const expectedRecords = new Map([
    ...manifest.source.files.map((entry): [string, AfterMinerUFileRecord] => [entry.path, entry]),
    ...manifest.derived.files.map((entry): [string, AfterMinerUFileRecord] => [entry.path, entry])
  ]);
  for (const [entry, expectedPath] of [
    [sourceArticle, manifest.source.article_path],
    [sourceContentList, manifest.source.content_list_path],
    [derivedArticle, manifest.derived.article_path]
  ] as const) {
    const expected = expectedRecords.get(expectedPath);
    if (!expected || entry.path !== expected.path || entry.size !== expected.size || entry.sha256 !== expected.sha256) {
      throw new AfterMinerUPackageValidationError(`Reader projection input is not manifest-bound: ${entry.path}`);
    }
  }

  const availablePaths = new Set([
    AFTER_MINERU_MANIFEST_PATH,
    ...manifest.source.files.map((entry) => entry.path),
    ...manifest.derived.files.map((entry) => entry.path),
    ...manifest.sidecars.files.map((entry) => entry.path),
    ...manifest.compatibility.aliases.map((entry) => entry.path)
  ]);
  const sourcePdfPaths = new Set<string>();
  if (manifest.source.pdf_path) {
    sourcePdfPaths.add(manifest.source.pdf_path);
    manifest.compatibility.aliases
      .filter((entry) => entry.canonical_path === manifest.source.pdf_path)
      .forEach((entry) => sourcePdfPaths.add(entry.path));
  }
  const visualIds = new Set<string>();
  const visuals = projection.visuals.map((value, index): AfterMinerUProjectedVisual => {
    const visual = record(value);
    if (!visual) throw new AfterMinerUPackageValidationError(`Reader projection visual ${index} is invalid`);
    exactKeys(visual, [
      "id",
      "kind",
      "path",
      "label",
      "caption_text",
      "page_index",
      "placement_block_id",
      "source_bbox",
      "member_asset_paths",
      "member_block_ids",
      "caption_page_index",
      "caption_status",
      "display"
    ], `Reader projection visual ${index}`);
    const id = typeof visual.id === "string" ? visual.id : "";
    const kind = visual.kind;
    const path = typeof visual.path === "string" ? visual.path : "";
    const label = typeof visual.label === "string" ? visual.label : "";
    const pageIndex = visual.page_index === null ? null : nonnegativeInteger(visual.page_index, `visual ${id} page_index`);
    const captionPageIndex = visual.caption_page_index === null
      ? null
      : nonnegativeInteger(visual.caption_page_index, `visual ${id} caption_page_index`);
    const placement = visual.placement_block_id === null || typeof visual.placement_block_id === "string"
      ? visual.placement_block_id as string | null
      : undefined;
    const caption = visual.caption_text === null || typeof visual.caption_text === "string"
      ? visual.caption_text as string | null
      : undefined;
    const captionStatus = visual.caption_status;
    if (
      !SAFE_ID.test(id)
      || visualIds.has(id)
      || !["figure", "table", "equation", "unknown"].includes(String(kind))
      || !isSafeAfterMinerUPath(path)
      || !availablePaths.has(path)
      || !label
      || label.length > 2000
      || caption === undefined
      || (caption !== null && caption.length > 100_000)
      || placement === undefined
      || (placement !== null && !SAFE_ID.test(placement))
      || ![null, "complete", "partial"].includes(captionStatus as null | string)
    ) throw new AfterMinerUPackageValidationError(`Reader projection visual ${index} is unsafe or unbound`);
    visualIds.add(id);
    const memberAssetPaths = safeStringArray(visual.member_asset_paths, `visual ${id} member_asset_paths`, true);
    const memberBlockIds = safeStringArray(visual.member_block_ids, `visual ${id} member_block_ids`);
    if (memberAssetPaths.some((entry) => !availablePaths.has(entry))) {
      throw new AfterMinerUPackageValidationError(`Reader projection visual ${id} references an unbound member asset`);
    }
    const display = parseDisplay(visual.display, `visual ${id} display`);
    if (display.mode === "pdf-crop" && !sourcePdfPaths.has(display.pdf_path)) {
      throw new AfterMinerUPackageValidationError(`Reader projection visual ${id} PDF crop is not bound to the source PDF`);
    }
    const displayPaths = display.mode === "pdf-crop"
      ? [display.pdf_path]
      : display.mode === "fragment-set"
        ? display.fragments.map((fragment) => fragment.path)
        : [path];
    if (displayPaths.some((entry) => !availablePaths.has(entry))) {
      throw new AfterMinerUPackageValidationError(`Reader projection visual ${id} display is not manifest-bound`);
    }
    return {
      id,
      kind: kind as AfterMinerUProjectedVisual["kind"],
      path,
      label,
      caption_text: caption,
      page_index: pageIndex,
      placement_block_id: placement,
      source_bbox: visual.source_bbox === null ? null : normalizedBbox(visual.source_bbox, `visual ${id} source_bbox`),
      member_asset_paths: memberAssetPaths,
      member_block_ids: memberBlockIds,
      caption_page_index: captionPageIndex,
      caption_status: captionStatus as AfterMinerUProjectedVisual["caption_status"],
      display
    };
  });
  const parsedSummary = {
    visual_count: nonnegativeInteger(summary.visual_count, "Reader projection summary.visual_count"),
    repaired_visual_count: nonnegativeInteger(summary.repaired_visual_count, "Reader projection summary.repaired_visual_count"),
    hidden_visual_count: nonnegativeInteger(summary.hidden_visual_count, "Reader projection summary.hidden_visual_count"),
    review_candidate_count: nonnegativeInteger(summary.review_candidate_count, "Reader projection summary.review_candidate_count"),
    unresolved_text_replacement_count: nonnegativeInteger(summary.unresolved_text_replacement_count, "Reader projection summary.unresolved_text_replacement_count")
  };
  if (parsedSummary.visual_count !== visuals.length) {
    throw new AfterMinerUPackageValidationError("Reader projection visual count does not match its summary");
  }
  return {
    schema_version: 1,
    contract: AFTER_MINERU_READER_PROJECTION_VERSION,
    inputs: {
      source_article: sourceArticle,
      source_content_list: sourceContentList,
      derived_article: derivedArticle
    },
    visuals,
    summary: parsedSummary
  };
}

async function readBounded(
  reader: AfterMinerUPackageReader,
  path: string,
  limit: number,
  label: string
): Promise<Uint8Array> {
  const info = await reader.fileInfo?.(path);
  if (info && info.size > limit) throw new AfterMinerUPackageValidationError(`${label} exceeds the safe size limit`);
  if (!await reader.exists(path)) throw new AfterMinerUPackageValidationError(`${label} is missing: ${path}`);
  const value = await reader.readBinary(path);
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength > limit || (info && info.size !== bytes.byteLength)) {
    throw new AfterMinerUPackageValidationError(`${label} size is invalid: ${path}`);
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AfterMinerUPackageValidationError(`${label} is not valid UTF-8 JSON`);
  }
}

async function verifyRecord(reader: AfterMinerUPackageReader, entry: AfterMinerUFileRecord): Promise<Uint8Array> {
  const bytes = (await readBounded(reader, entry.path, Math.max(entry.size, 1), entry.path)).slice();
  if (bytes.byteLength !== entry.size || sha256Bytes(bytes) !== entry.sha256) {
    throw new AfterMinerUPackageValidationError(`File does not match the manifest: ${entry.path}`);
  }
  return bytes;
}

async function assertExactFormalInventory(
  reader: AfterMinerUPackageReader,
  manifest: AfterMinerUManifest
): Promise<void> {
  if (!reader.enumeratePaths) return;
  const actualPaths = [...await reader.enumeratePaths()];
  const expectedPaths = [
    AFTER_MINERU_MANIFEST_PATH,
    ...manifest.source.files.map((entry) => entry.path),
    ...manifest.derived.files.map((entry) => entry.path),
    ...manifest.sidecars.files.map((entry) => entry.path),
    ...manifest.compatibility.aliases.map((entry) => entry.path)
  ];
  const actualCanonical = new Set<string>();
  for (const path of actualPaths) {
    const canonical = canonicalPath(path);
    if (!isSafeAfterMinerUPath(path) || actualCanonical.has(canonical)) {
      throw new AfterMinerUPackageValidationError(`Formal package inventory contains an unsafe or conflicting path: ${path}`);
    }
    actualCanonical.add(canonical);
  }
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);
  const extra = actualPaths.find((path) => !expected.has(path));
  if (extra) throw new AfterMinerUPackageValidationError(`Formal package contains an unmanifested file: ${extra}`);
  const missing = expectedPaths.find((path) => !actual.has(path));
  if (missing || actualPaths.length !== expectedPaths.length) {
    throw new AfterMinerUPackageValidationError(`Formal package inventory is incomplete: ${missing ?? "path count mismatch"}`);
  }
}

function assertSourceArchiveTree(
  archiveBytes: Uint8Array,
  provenance: AfterMinerUProvenance
): void {
  let archiveEntries: Map<string, Uint8Array>;
  try {
    archiveEntries = extractValidatedZipEntries(
      archiveBytes,
      AFTER_MINERU_SOURCE_ARCHIVE_LIMITS,
      isSafeAfterMinerUPath
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AfterMinerUPackageValidationError(`Embedded source archive failed structural validation: ${detail}`);
  }
  const bindings = new Map(provenance.source_tree.entries.map((entry) => [entry.archive_path, entry]));
  if (archiveEntries.size !== bindings.size) {
    throw new AfterMinerUPackageValidationError("Embedded source archive inventory does not match provenance");
  }
  for (const [path, bytes] of archiveEntries) {
    const binding = bindings.get(path);
    if (
      !binding
      || binding.size !== bytes.byteLength
      || binding.sha256 !== sha256Bytes(bytes)
      || binding.package_path !== `source/${path.slice(provenance.source_tree.root_prefix.length)}`
    ) {
      throw new AfterMinerUPackageValidationError(`Embedded source archive entry does not match provenance: ${path}`);
    }
  }
}

export async function validateAfterMinerUPackage(reader: AfterMinerUPackageReader): Promise<VerifiedAfterMinerUPackage> {
  const manifestBytes = await readBounded(reader, AFTER_MINERU_MANIFEST_PATH, MAX_MANIFEST_BYTES, "After-MinerU manifest");
  const manifest = parseAfterMinerUManifest(decodeJson(manifestBytes, "After-MinerU manifest"));
  await assertExactFormalInventory(reader, manifest);
  const records = [...manifest.source.files, ...manifest.derived.files, ...manifest.sidecars.files];
  const allCanonicalPaths = new Set<string>([canonicalPath(AFTER_MINERU_MANIFEST_PATH)]);
  let totalBytes = manifestBytes.byteLength;
  for (const entry of [...records, ...manifest.compatibility.aliases]) {
    const canonical = canonicalPath(entry.path);
    if (allCanonicalPaths.has(canonical)) throw new AfterMinerUPackageValidationError(`Package path collision: ${entry.path}`);
    allCanonicalPaths.add(canonical);
    totalBytes += entry.size;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new AfterMinerUPackageValidationError("After-MinerU package exceeds the aggregate size limit");
  }
  const verifiedRecordBytes = new Map<string, Uint8Array>();
  for (const entry of records) verifiedRecordBytes.set(entry.path, await verifyRecord(reader, entry));
  for (const entry of manifest.compatibility.aliases) await verifyRecord(reader, entry);

  const validationRecord = manifest.sidecars.files.find((entry) => entry.path === manifest.sidecars.validation_path)!;
  if (validationRecord.size > MAX_VALIDATION_BYTES) throw new AfterMinerUPackageValidationError("After-MinerU validation exceeds the safe size limit");
  const validationBytes = verifiedRecordBytes.get(validationRecord.path)!;
  const validation = parseAfterMinerUValidation(decodeJson(validationBytes, "After-MinerU validation"), manifest);
  const provenanceRecord = manifest.sidecars.files.find((entry) => entry.path === manifest.sidecars.provenance_path)!;
  if (provenanceRecord.size > MAX_PROVENANCE_BYTES) throw new AfterMinerUPackageValidationError("After-MinerU provenance exceeds the safe size limit");
  const provenanceBytes = verifiedRecordBytes.get(provenanceRecord.path)!;
  const provenance = parseAfterMinerUProvenance(decodeJson(provenanceBytes, "After-MinerU provenance"), manifest);
  assertSourceArchiveTree(verifiedRecordBytes.get(manifest.source.archive_path)!, provenance);
  const projectionRecord = manifest.sidecars.files.find((entry) => entry.path === manifest.sidecars.reader_projection_path)!;
  if (projectionRecord.size > MAX_PROJECTION_BYTES) throw new AfterMinerUPackageValidationError("After-MinerU Reader projection exceeds the safe size limit");
  const projectionBytes = verifiedRecordBytes.get(projectionRecord.path)!;
  const readerProjection = parseAfterMinerUReaderProjection(
    decodeJson(projectionBytes, "After-MinerU Reader projection"),
    manifest
  );
  if (
    validation.summary.repaired_visual_count !== readerProjection.summary.repaired_visual_count
    || validation.summary.review_candidate_count !== readerProjection.summary.review_candidate_count
    || validation.summary.unresolved_text_replacement_count !== readerProjection.summary.unresolved_text_replacement_count
  ) {
    throw new AfterMinerUPackageValidationError("After-MinerU validation and Reader projection summaries do not match");
  }
  return {
    manifest,
    validation,
    provenance,
    readerProjection,
    records: new Map(records.map((entry) => [entry.path, entry]))
  };
}

export function mapAfterMinerUPackageReader(files: ReadonlyMap<string, Uint8Array>): AfterMinerUPackageReader {
  return {
    async exists(path) { return files.has(path); },
    async readBinary(path) {
      const value = files.get(path);
      if (!value) throw new AfterMinerUPackageValidationError(`Package file is missing: ${path}`);
      return value;
    },
    async fileInfo(path) {
      const value = files.get(path);
      return value ? { size: value.byteLength } : undefined;
    },
    async enumeratePaths() { return [...files.keys()]; }
  };
}
