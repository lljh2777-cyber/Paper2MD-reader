import { zipSync, type Zippable } from "fflate";
import {
  AFTER_MINERU_ATTRIBUTION_ALIAS_PATH,
  AFTER_MINERU_ATTRIBUTION_PATH,
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_LIMITS,
  AFTER_MINERU_PACKAGE_VERSION,
  AFTER_MINERU_PROVENANCE_VERSION,
  AFTER_MINERU_READER_PROJECTION_VERSION,
  AFTER_MINERU_REPAIR_ALGORITHM_VERSION,
  AFTER_MINERU_VALIDATION_VERSION,
  type AfterMinerUCompatibilityAlias,
  type AfterMinerUFileRecord,
  type AfterMinerUManifest,
  type AfterMinerUNormalizedBBox,
  type AfterMinerUProjectedVisual,
  type AfterMinerUProvenance,
  type AfterMinerUReaderProjection,
  type AfterMinerUValidation,
  isSafeAfterMinerUPath,
  mapAfterMinerUPackageReader,
  sha256Bytes,
  validateAfterMinerUPackage
} from "../../after-mineru-contract/src/index";
import { extractMinerUArchiveForReader, MINERU_ARCHIVE_READER_LIMITS } from "../../../src/model/mineru-archive";
import { parseMinerUContentList } from "../../../src/model/mineru-content-list";
import {
  applyMinerUDisplayCaptionRepairs,
  applyMinerUDisplayMarkdownRepairs,
  prepareMinerUDisplayRepair
} from "../../../src/model/mineru-display-repair";
import { applyMinerUVisualRepair, type RepairedMinerUVisual } from "../../../src/model/mineru-visual-repair";
import { projectMinerUReaderMarkdown } from "../../../src/model/mineru-reader-projection";
import { prepareMinerUVisualReview } from "../../../src/model/mineru-visual-review";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  buildMineruVisualRepair,
  extractMarkdownImageOccurrences
} from "./reader-contract-generator";
import {
  buildPortableMarkdownExport,
  PortableMarkdownUnavailableError,
  type BuiltPortableMarkdownExport,
  type PortableMarkdownUnavailableReason
} from "./portable-markdown";

const SOURCE_ARCHIVE_PATH = "source/mineru-original.mineru.zip";
const DERIVED_ARTICLE_PATH = "derived/article.after-mineru.md";
const READER_PROJECTION_PATH = "sidecars/reader-projection.json";
const VIEWER_INDEX_PATH = "sidecars/viewer-index.json";
const VISUAL_REPAIR_PATH = "sidecars/visual-repair.json";
const VISUAL_CANDIDATES_PATH = "sidecars/visual-candidates.json";
const DISPLAY_REPAIR_PATH = "sidecars/display-repair.json";
const PROVENANCE_PATH = "sidecars/provenance.json";
export const AFTER_MINERU_REPAIR_REPORT_PATH = "sidecars/repair-report.json";
export const AFTER_MINERU_REPAIR_REPORT_VERSION = "after-mineru-repair-report-v1";
const LEGACY_MANIFEST_PATH = "sidecars/paper2md-v0.1.3-manifest.json";
const LEGACY_VALIDATION_PATH = "sidecars/paper2md-v0.1.3-validation.json";
const VALIDATION_PATH = "sidecars/validation.json";
const LEGACY_PDF_PATH = "_extraction/source.pdf";
// fflate encodes DOS timestamps through local Date fields. Constructing the
// fixed epoch in local time keeps the emitted bytes stable in every timezone
// and avoids crossing into 1979 west of UTC.
const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const MAX_SOURCE_PDF_BYTES = 64 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

export interface RepairSourcePdf {
  bytes: Uint8Array;
  name?: string;
}

export interface RepairDisplayRepair {
  /**
   * A precomputed display-repair sidecar. Repair revalidates every source
   * hash, block identity, exact source range, replacement hash, and PDF hash
   * before materializing it; this is not a loose text override. The binding
   * does not authenticate who authored the sidecar or infer replacements
   * from PDF bytes, so callers must obtain it from a trusted repair workflow.
   */
  bytes: Uint8Array;
  name?: string;
}

export interface RepairAttribution {
  /** Manifest-bound attribution or licensing Markdown supplied by the caller. */
  bytes: Uint8Array;
}

export interface RepairMinerUArchiveInput {
  archiveBytes: Uint8Array;
  archiveName?: string;
  sourcePdf?: RepairSourcePdf;
  displayRepair?: RepairDisplayRepair;
  attribution?: RepairAttribution;
}

export interface RepairMinerUArchiveSummary {
  sourceFileCount: number;
  sourceImageCount: number;
  visibleVisualCount: number;
  repairedVisualCount: number;
  reviewCandidateCount: number;
  unresolvedTextReplacementCount: number;
  sourcePdfIncluded: boolean;
}

export type RepairProgressStage =
  | "inspect-source"
  | "parse-content"
  | "analyze-visuals"
  | "materialize-derived"
  | "bind-package"
  | "verify-package"
  | "build-portable-export"
  | "compress-portable-export"
  | "compress-verified-package"
  | "compress-package"
  | "complete";

export interface RepairProgress {
  stage: RepairProgressStage;
  percent: number;
}

export interface RepairExecutionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RepairProgress) => void;
}

export type RepairReportWarningCode =
  | "source-pdf-unavailable"
  | "review-candidates-present"
  | "unresolved-text-replacements";

export interface AfterMinerURepairReport {
  schema_version: 1;
  contract: typeof AFTER_MINERU_REPAIR_REPORT_VERSION;
  algorithm_version: string;
  status: "passed";
  source_archive_sha256: string;
  derived_article_sha256: string;
  source_pdf_included: boolean;
  checks: {
    source_archive_validated: true;
    source_tree_bound: true;
    derived_article_materialized: true;
    reader_projection_bound: true;
    compatibility_profile_generated: true;
  };
  summary: {
    source_file_count: number;
    source_image_count: number;
    visible_visual_count: number;
    repaired_visual_count: number;
    review_candidate_count: number;
    unresolved_text_replacement_count: number;
  };
  warnings: Array<{ code: RepairReportWarningCode; count: number }>;
}

export interface RepairMinerUArchiveResult {
  archiveName: string;
  files: ReadonlyMap<string, Uint8Array>;
  manifest: AfterMinerUManifest;
  validation: AfterMinerUValidation;
  readerProjection: AfterMinerUReaderProjection;
  report: AfterMinerURepairReport;
  summary: RepairMinerUArchiveSummary;
}

export interface BuiltAfterMinerUArchive extends RepairMinerUArchiveResult {
  archiveBytes: Uint8Array;
}

export type PortableMarkdownExportOutcome =
  | { status: "ready"; output: BuiltPortableMarkdownExport }
  | { status: "unavailable"; reason: PortableMarkdownUnavailableReason };

export interface BuiltAfterMinerUExports {
  verifiedPackage: BuiltAfterMinerUArchive;
  portableMarkdown: PortableMarkdownExportOutcome;
}

export class RepairExecutionCancelledError extends Error {
  constructor() {
    super("After-MinerU repair was cancelled");
    this.name = "RepairExecutionCancelledError";
  }
}

function checkpoint(options: RepairExecutionOptions | undefined): void {
  if (options?.signal?.aborted) throw new RepairExecutionCancelledError();
}

function emitProgress(
  options: RepairExecutionOptions | undefined,
  stage: RepairProgressStage,
  percent: number
): void {
  checkpoint(options);
  try {
    options?.onProgress?.({ stage, percent });
  } catch {
    // Progress observers are informational and must not affect deterministic output.
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function fileRecord(path: string, bytes: Uint8Array): AfterMinerUFileRecord {
  return { path, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecords(paths: Iterable<string>, files: ReadonlyMap<string, Uint8Array>): AfterMinerUFileRecord[] {
  return [...paths].sort(compareCodeUnits)
    .map((path) => fileRecord(path, files.get(path)!));
}

function safeArchiveStem(name: string | undefined): string {
  const stem = (name ?? "paper")
    .replace(/(?:\.mineru)?\.zip$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "paper";
}

function canonicalKey(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

function addFile(files: Map<string, Uint8Array>, canonicalPaths: Set<string>, path: string, bytes: Uint8Array): void {
  const key = canonicalKey(path);
  if (!isSafeAfterMinerUPath(path) || canonicalPaths.has(key)) throw new Error(`After-MinerU output path conflicts: ${path}`);
  canonicalPaths.add(key);
  files.set(path, bytes);
}

function addAlias(
  files: Map<string, Uint8Array>,
  canonicalPaths: Set<string>,
  aliases: AfterMinerUCompatibilityAlias[],
  path: string,
  canonicalPath: string
): AfterMinerUCompatibilityAlias {
  const target = files.get(canonicalPath);
  if (!target) throw new Error(`After-MinerU alias target is missing: ${canonicalPath}`);
  const key = canonicalKey(path);
  if (!isSafeAfterMinerUPath(path)) throw new Error(`After-MinerU compatibility path is unsafe: ${path}`);
  if (canonicalPaths.has(key)) {
    const existing = aliases.find((entry) => canonicalKey(entry.path) === key);
    if (existing && existing.canonical_path === canonicalPath) return existing;
    throw new Error(`After-MinerU compatibility path conflicts: ${path}`);
  }
  canonicalPaths.add(key);
  files.set(path, target);
  const alias = { ...fileRecord(path, target), canonical_path: canonicalPath };
  aliases.push(alias);
  return alias;
}

function sourcePdfFromArchive(files: ReadonlyMap<string, Uint8Array>): { path: string; bytes: Uint8Array } | undefined {
  const candidates = [...files].filter(([path]) => /(?:^|\/)[^/]*_origin\.pdf$/i.test(path));
  return candidates.length === 1 ? { path: candidates[0]![0], bytes: candidates[0]![1] } : undefined;
}

function assertPdf(bytes: Uint8Array): void {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_SOURCE_PDF_BYTES) {
    throw new Error("The selected source PDF is empty or exceeds the 64 MB repair limit");
  }
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The selected source PDF does not have a valid PDF header");
  }
}

function bbox(value: AfterMinerUNormalizedBBox | undefined): AfterMinerUNormalizedBBox | null {
  return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}

function projectedDisplay(visual: RepairedMinerUVisual): AfterMinerUProjectedVisual["display"] {
  if (visual.display?.mode === "pdf-crop") {
    return {
      mode: "pdf-crop",
      pdf_path: LEGACY_PDF_PATH,
      bbox: { ...visual.display.bbox },
      padding: visual.display.padding
    };
  }
  if (visual.display?.mode === "fragment-set") {
    return {
      mode: "fragment-set",
      fragments: visual.display.fragments.map((fragment) => ({ path: fragment.path, bbox: { ...fragment.bbox } }))
    };
  }
  return { mode: "asset" };
}

function projectedVisual(visual: RepairedMinerUVisual): AfterMinerUProjectedVisual {
  const kind = ["figure", "table", "equation"].includes(visual.kind) ? visual.kind : "unknown";
  return {
    id: visual.id,
    kind: kind as AfterMinerUProjectedVisual["kind"],
    path: visual.path,
    label: visual.label || visual.id,
    caption_text: visual.captionText ?? null,
    page_index: visual.pageIndex ?? null,
    placement_block_id: visual.placementBlockId ?? null,
    source_bbox: bbox(visual.bbox),
    member_asset_paths: [...(visual.memberAssetPaths ?? [visual.path])],
    member_block_ids: [...(visual.memberBlockIds ?? [])],
    caption_page_index: visual.captionPageIndex ?? null,
    caption_status: visual.captionStatus ?? null,
    display: projectedDisplay(visual)
  };
}

function candidateCount(value: unknown): number {
  const candidates = record(value)?.candidates;
  return Array.isArray(candidates) ? candidates.length : 0;
}

function legacyElementSummary(payload: unknown): { elementCount: number; pageCount: number } {
  if (!Array.isArray(payload)) return { elementCount: 0, pageCount: 0 };
  if (payload.length > 0 && payload.every(Array.isArray)) {
    return {
      elementCount: payload.reduce((total, page) => total + (page as unknown[]).filter((item) => record(item)).length, 0),
      pageCount: payload.length
    };
  }
  const records = payload.map(record).filter((item): item is UnknownRecord => Boolean(item));
  const pageIndexes = records
    .map((item) => Number(item.page_idx))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return {
    elementCount: records.length,
    pageCount: pageIndexes.length ? Math.max(...pageIndexes) + 1 : records.length ? 1 : 0
  };
}

function compatibilityManifest(input: {
  aliases: AfterMinerUCompatibilityAlias[];
  sourcePdf?: AfterMinerUCompatibilityAlias;
  viewer: AfterMinerUCompatibilityAlias;
  repair: AfterMinerUCompatibilityAlias;
  candidates: AfterMinerUCompatibilityAlias;
  display?: AfterMinerUCompatibilityAlias;
  attribution?: AfterMinerUCompatibilityAlias;
}): UnknownRecord {
  const derivedContracts = [input.viewer, input.repair, input.candidates];
  if (input.display) derivedContracts.push(input.display);
  if (input.attribution) derivedContracts.push(input.attribution);
  const derivedPaths = new Set(derivedContracts.map((entry) => entry.path));
  const outputs = input.aliases
    .filter((entry) => !derivedPaths.has(entry.path))
    .filter((entry) => !entry.path.startsWith("_extraction/") && !entry.path.startsWith("_source/"))
    .map(({ canonical_path: _canonical, ...entry }) => entry);
  const sourcePdf = input.sourcePdf;
  return {
    schema_version: 1,
    extractor: "after-mineru-repair-core",
    created_at: "1980-01-01T00:00:00.000Z",
    processing_depth: "conversion-only",
    source: sourcePdf ? {
      original_name: "source.pdf",
      size: sourcePdf.size,
      sha256: sourcePdf.sha256
    } : {
      original_name: "not-included.pdf",
      size: 0,
      sha256: "0".repeat(64)
    },
    privacy: {
      remote_processing: false,
      source_pdf_packaged: Boolean(sourcePdf),
      notice: "After-MinerU Repair ran locally and preserved the original MinerU archive byte-for-byte."
    },
    options: { include_source_pdf: Boolean(sourcePdf) },
    outputs,
    derived_contracts: derivedContracts
      .map(({ canonical_path: _canonical, ...entry }) => entry)
  };
}

function compatibilityValidation(summary: RepairMinerUArchiveSummary, input: {
  article: string;
  mineruPayload: unknown;
  jsonAssets: string[];
  markdownAssets: string[];
  sourcePaths: ReadonlySet<string>;
}): UnknownRecord {
  const elements = legacyElementSummary(input.mineruPayload);
  const jsonAssets = new Set(input.jsonAssets);
  const markdownAssets = new Set(input.markdownAssets);
  const jsonAssetsExist = [...jsonAssets].every((path) => input.sourcePaths.has(path));
  const markdownAssetsExist = [...markdownAssets].every((path) => input.sourcePaths.has(path));
  const markdownNonempty = Boolean(input.article.trim());
  const titleHeadingPresent = /^#\s+\S/m.test(input.article);
  if (!markdownNonempty || !titleHeadingPresent || !jsonAssetsExist || !markdownAssetsExist) {
    throw new Error("Generated package does not satisfy the Paper2MD Reader v0.1.3 compatibility validation");
  }
  return {
    status: "passed",
    checks: {
      markdown_nonempty: markdownNonempty,
      title_heading_present: titleHeadingPresent,
      json_array_valid: true,
      json_assets_exist: jsonAssetsExist,
      markdown_assets_exist: markdownAssetsExist,
      immutable_source_preserved: true,
      source_pdf_preserved: true,
      viewer_index_valid: true,
      visual_repair_valid: true,
      visual_candidates_valid: true
    },
    page_count: elements.pageCount,
    json_element_count: elements.elementCount,
    json_asset_count: jsonAssets.size,
    markdown_asset_count: markdownAssets.size,
    unreferenced_json_assets: [...jsonAssets].filter((path) => !markdownAssets.has(path)).sort(compareCodeUnits),
    viewer_contracts: {
      viewer: { visual_count: summary.visibleVisualCount },
      repair: { repaired_visual_count: summary.repairedVisualCount },
      candidates: { candidate_count: summary.reviewCandidateCount }
    }
  };
}

async function runRepairMinerUArchive(
  input: RepairMinerUArchiveInput,
  options?: RepairExecutionOptions
): Promise<RepairMinerUArchiveResult> {
  const attributionByteLength = input.attribution?.bytes.byteLength;
  if (attributionByteLength !== undefined && (
    attributionByteLength < 1
    || attributionByteLength > AFTER_MINERU_PACKAGE_LIMITS.attributionBytes
  )) {
    throw new Error("Attribution is empty or outside the safe metadata size limit");
  }
  // Snapshot caller-owned buffers before parsing or reaching the first await.
  // The generated hashes, source tree, and exported bytes must all describe
  // one immutable input observation.
  const archiveBytes = input.archiveBytes.slice();
  const sourcePdfInput = input.sourcePdf
    ? { bytes: input.sourcePdf.bytes.slice(), name: input.sourcePdf.name }
    : undefined;
  const displayRepairInput = input.displayRepair
    ? { bytes: input.displayRepair.bytes.slice(), name: input.displayRepair.name }
    : undefined;
  const attributionInput = input.attribution
    ? { bytes: input.attribution.bytes.slice() }
    : undefined;
  if (attributionInput) {
    const attributionText = decodeUtf8(attributionInput.bytes, "attribution");
    if (!attributionText.trim() || attributionText.includes("\0")) {
      throw new Error("Attribution must be non-empty UTF-8 Markdown without null bytes");
    }
  }
  const archiveName = input.archiveName;
  emitProgress(options, "inspect-source", 5);
  const extraction = extractMinerUArchiveForReader(archiveBytes, MINERU_ARCHIVE_READER_LIMITS);
  emitProgress(options, "parse-content", 18);
  const sourceArticleBytes = extraction.files.get(extraction.articlePath)!;
  const contentListBytes = extraction.files.get(extraction.contentListPath)!;
  const sourceArticle = decodeUtf8(sourceArticleBytes, "MinerU Markdown");
  const contentListText = decodeUtf8(contentListBytes, "MinerU content list");
  let mineruPayload: unknown;
  try {
    mineruPayload = JSON.parse(contentListText) as unknown;
  } catch {
    throw new Error("MinerU content list is not valid JSON");
  }
  const parsed = parseMinerUContentList(mineruPayload);
  const articleHash = sha256Bytes(sourceArticleBytes);
  const mineruHash = sha256Bytes(contentListBytes);
  const embeddedPdf = sourcePdfFromArchive(extraction.files);
  const selectedPdf = sourcePdfInput
    ? { path: "source/source.pdf", bytes: sourcePdfInput.bytes }
    : embeddedPdf
      ? { path: `source/${embeddedPdf.path}`, bytes: embeddedPdf.bytes }
      : undefined;
  if (selectedPdf) assertPdf(selectedPdf.bytes);
  if (displayRepairInput && !selectedPdf) {
    throw new Error("Display repair requires a byte-verified source PDF");
  }
  if (displayRepairInput && (
    displayRepairInput.bytes.byteLength < 2
    || displayRepairInput.bytes.byteLength > AFTER_MINERU_PACKAGE_LIMITS.projectionBytes
  )) {
    throw new Error("Display repair is outside the safe sidecar size limit");
  }
  emitProgress(options, "analyze-visuals", 34);
  const markdownImages = extractMarkdownImageOccurrences(sourceArticle);
  const viewerIndex = buildMineruViewerIndex(
    mineruPayload,
    markdownImages,
    { article: articleHash, mineru_result: mineruHash },
    { packagedSourcePdf: Boolean(selectedPdf), sourceAvailableAtGeneration: Boolean(selectedPdf) }
  );
  const visualRepair = buildMineruVisualRepair(viewerIndex);
  const visualCandidates = buildMineruVisualCandidates(viewerIndex, visualRepair);
  let displayRepairContract: unknown | undefined;
  if (displayRepairInput) {
    try {
      displayRepairContract = JSON.parse(decodeUtf8(displayRepairInput.bytes, "display repair")) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UTF-8")) throw error;
      throw new Error("Display repair is not valid JSON");
    }
  }
  const visualCandidatesBytes = jsonBytes(visualCandidates);
  const preparedReview = await prepareMinerUVisualReview({
    candidatePackage: visualCandidates,
    viewerIndex,
    visualRepair,
    articleHash,
    mineruHash,
    mineruPayload,
    articleMarkdown: sourceArticle,
    sourcePdfPath: selectedPdf ? LEGACY_PDF_PATH : undefined,
    candidateFileHash: sha256Bytes(visualCandidatesBytes)
  });
  if (!preparedReview.review || preparedReview.diagnostics.some((item) => item.code === "mineru-visual-review-invalid")) {
    throw new Error("Generated visual repair contracts failed deterministic validation");
  }
  const applied = applyMinerUVisualRepair({
    visuals: parsed.visuals,
    viewerIndex,
    visualRepair,
    mineruPayload,
    articleMarkdown: sourceArticle,
    articleHash,
    mineruHash,
    sourcePdfPath: selectedPdf ? LEGACY_PDF_PATH : undefined
  });
  if (applied.diagnostics.some((item) => item.code.endsWith("-invalid"))) {
    throw new Error("Generated visual repair could not be applied transactionally");
  }
  const displayRepairPlan = displayRepairContract === undefined
    ? undefined
    : await prepareMinerUDisplayRepair({
      contract: displayRepairContract,
      viewerIndex,
      mineruPayload,
      sourceArticle,
      articleHash,
      mineruHash,
      sourcePdfHash: sha256Bytes(selectedPdf!.bytes)
    });
  const displayVisuals = displayRepairPlan
    ? applyMinerUDisplayCaptionRepairs(applied.visuals, displayRepairPlan)
    : applied.visuals;
  const projected = projectMinerUReaderMarkdown({
    markdown: sourceArticle,
    // Projection must locate/remove the exact original caption text. The
    // verified replacement is carried by readerProjection.visuals instead.
    visuals: applied.visuals,
    viewerIndex,
    articleHash,
    mineruHash
  });
  if (projected.diagnostics.some((item) => item.code === "mineru-reader-projection-binding-invalid")) {
    throw new Error("Generated Reader projection is not bound to the source Markdown");
  }
  const projectedMarkdown = displayRepairPlan
    ? applyMinerUDisplayMarkdownRepairs(projected.markdown, displayRepairPlan)
    : projected.markdown;

  emitProgress(options, "materialize-derived", 58);
  const files = new Map<string, Uint8Array>();
  const canonicalPaths = new Set<string>();
  addFile(files, canonicalPaths, SOURCE_ARCHIVE_PATH, archiveBytes);
  for (const [path, bytes] of [...extraction.files].sort(([left], [right]) => compareCodeUnits(left, right))) {
    addFile(files, canonicalPaths, `source/${path}`, bytes);
  }
  if (sourcePdfInput) addFile(files, canonicalPaths, "source/source.pdf", sourcePdfInput.bytes);
  const sourcePaths = [...files.keys()].filter((path) => path.startsWith("source/"));
  const sourceRecords = sortedRecords(sourcePaths, files);
  const sourceArticlePath = `source/${extraction.articlePath}`;
  const sourceContentListPath = `source/${extraction.contentListPath}`;
  const sourceArticleRecord = sourceRecords.find((entry) => entry.path === sourceArticlePath)!;
  const sourceContentListRecord = sourceRecords.find((entry) => entry.path === sourceContentListPath)!;
  const sourceArchiveRecord = sourceRecords.find((entry) => entry.path === SOURCE_ARCHIVE_PATH)!;

  const derivedArticleBytes = new TextEncoder().encode(projectedMarkdown);
  addFile(files, canonicalPaths, DERIVED_ARTICLE_PATH, derivedArticleBytes);
  const derivedArticleRecord = fileRecord(DERIVED_ARTICLE_PATH, derivedArticleBytes);
  const visibleVisuals = displayVisuals.filter((visual) => !visual.hidden);
  const repairedVisualCount = visibleVisuals.filter((visual) => (
    (visual.display !== undefined && visual.display.mode !== "asset")
    || (visual.memberAssetPaths?.length ?? 0) > 1
  )).length;
  const unresolvedTextReplacementCount = [...projectedMarkdown].filter((character) => character === "\uFFFD").length;
  const reviewCandidateCount = candidateCount(visualCandidates);
  const readerProjection: AfterMinerUReaderProjection = {
    schema_version: 1,
    contract: AFTER_MINERU_READER_PROJECTION_VERSION,
    inputs: {
      source_article: sourceArticleRecord,
      source_content_list: sourceContentListRecord,
      derived_article: derivedArticleRecord
    },
    visuals: visibleVisuals.map(projectedVisual),
    summary: {
      visual_count: visibleVisuals.length,
      repaired_visual_count: repairedVisualCount,
      hidden_visual_count: applied.visuals.length - visibleVisuals.length,
      review_candidate_count: reviewCandidateCount,
      unresolved_text_replacement_count: unresolvedTextReplacementCount
    }
  };
  const summary: RepairMinerUArchiveSummary = {
    sourceFileCount: extraction.fileCount,
    sourceImageCount: extraction.imageCount,
    visibleVisualCount: visibleVisuals.length,
    repairedVisualCount,
    reviewCandidateCount,
    unresolvedTextReplacementCount,
    sourcePdfIncluded: Boolean(selectedPdf)
  };

  const provenance: AfterMinerUProvenance = {
    schema_version: 1,
    contract: AFTER_MINERU_PROVENANCE_VERSION,
    algorithm_version: AFTER_MINERU_REPAIR_ALGORITHM_VERSION,
    source_archive: sourceArchiveRecord,
    source_pdf: selectedPdf ? fileRecord(selectedPdf.path, selectedPdf.bytes) : null,
    source_pdf_origin: sourcePdfInput ? "explicit-selection" : embeddedPdf ? "archive-entry" : null,
    source_entry_count: extraction.fileCount,
    source_tree: {
      root_prefix: extraction.rootPrefix,
      entries: [...extraction.files]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([path, bytes]) => ({
          archive_path: `${extraction.rootPrefix}${path}`,
          package_path: `source/${path}`,
          size: bytes.byteLength,
          sha256: sha256Bytes(bytes)
        }))
    },
    derived_article: derivedArticleRecord,
    guarantees: [
      "The original MinerU ZIP and every extracted source entry are byte-preserved under source/.",
      "Derived content is stored separately and never overwrites full.md, MinerU JSON, images, or the source PDF.",
      "Reader projection activation requires complete manifest, size, path, and SHA-256 verification.",
      ...(displayRepairPlan ? [
        "The materialized display repair was rebound to exact source text, Viewer blocks, and a byte-verified source PDF."
      ] : []),
      ...(attributionInput ? [
        "Attribution metadata is stored as a separately manifest-bound sidecar and is not presented as MinerU source content."
      ] : [])
    ]
  };
  const warnings: AfterMinerURepairReport["warnings"] = [];
  if (!selectedPdf) warnings.push({ code: "source-pdf-unavailable", count: 1 });
  if (reviewCandidateCount > 0) warnings.push({ code: "review-candidates-present", count: reviewCandidateCount });
  if (unresolvedTextReplacementCount > 0) {
    warnings.push({ code: "unresolved-text-replacements", count: unresolvedTextReplacementCount });
  }
  const report: AfterMinerURepairReport = {
    schema_version: 1,
    contract: AFTER_MINERU_REPAIR_REPORT_VERSION,
    algorithm_version: AFTER_MINERU_REPAIR_ALGORITHM_VERSION,
    status: "passed",
    source_archive_sha256: sourceArchiveRecord.sha256,
    derived_article_sha256: derivedArticleRecord.sha256,
    source_pdf_included: Boolean(selectedPdf),
    checks: {
      source_archive_validated: true,
      source_tree_bound: true,
      derived_article_materialized: true,
      reader_projection_bound: true,
      compatibility_profile_generated: true
    },
    summary: {
      source_file_count: summary.sourceFileCount,
      source_image_count: summary.sourceImageCount,
      visible_visual_count: summary.visibleVisualCount,
      repaired_visual_count: summary.repairedVisualCount,
      review_candidate_count: summary.reviewCandidateCount,
      unresolved_text_replacement_count: summary.unresolvedTextReplacementCount
    },
    warnings
  };
  const sidecarValues: Array<[string, unknown]> = [
    [VIEWER_INDEX_PATH, viewerIndex],
    [VISUAL_REPAIR_PATH, visualRepair],
    [VISUAL_CANDIDATES_PATH, visualCandidates],
    [READER_PROJECTION_PATH, readerProjection],
    [PROVENANCE_PATH, provenance],
    [AFTER_MINERU_REPAIR_REPORT_PATH, report]
  ];
  if (displayRepairContract !== undefined) sidecarValues.push([DISPLAY_REPAIR_PATH, displayRepairContract]);
  emitProgress(options, "bind-package", 72);
  for (const [path, value] of sidecarValues) addFile(files, canonicalPaths, path, jsonBytes(value));
  if (attributionInput) addFile(files, canonicalPaths, AFTER_MINERU_ATTRIBUTION_PATH, attributionInput.bytes);

  const aliases: AfterMinerUCompatibilityAlias[] = [];
  for (const path of [...extraction.files.keys()].sort(compareCodeUnits)) {
    addAlias(files, canonicalPaths, aliases, path, `source/${path}`);
  }
  addAlias(files, canonicalPaths, aliases, "article.md", sourceArticlePath);
  addAlias(files, canonicalPaths, aliases, "mineru-result.json", sourceContentListPath);
  addAlias(files, canonicalPaths, aliases, "_source/mineru-original.mineru.zip", SOURCE_ARCHIVE_PATH);
  const sourcePdfAlias = selectedPdf
    ? addAlias(files, canonicalPaths, aliases, LEGACY_PDF_PATH, selectedPdf.path)
    : undefined;
  const viewerAlias = addAlias(files, canonicalPaths, aliases, "_extraction/viewer-index.json", VIEWER_INDEX_PATH);
  const repairAlias = addAlias(files, canonicalPaths, aliases, "_extraction/visual-repair.json", VISUAL_REPAIR_PATH);
  const candidatesAlias = addAlias(files, canonicalPaths, aliases, "_extraction/visual-candidates.json", VISUAL_CANDIDATES_PATH);
  const displayAlias = displayRepairContract === undefined
    ? undefined
    : addAlias(files, canonicalPaths, aliases, "_extraction/display-repair.json", DISPLAY_REPAIR_PATH);
  const attributionAlias = attributionInput === undefined
    ? undefined
    : addAlias(files, canonicalPaths, aliases, AFTER_MINERU_ATTRIBUTION_ALIAS_PATH, AFTER_MINERU_ATTRIBUTION_PATH);

  addFile(files, canonicalPaths, LEGACY_MANIFEST_PATH, jsonBytes(compatibilityManifest({
    aliases,
    sourcePdf: sourcePdfAlias,
    viewer: viewerAlias,
    repair: repairAlias,
    candidates: candidatesAlias,
    display: displayAlias,
    attribution: attributionAlias
  })));
  addFile(files, canonicalPaths, LEGACY_VALIDATION_PATH, jsonBytes(compatibilityValidation(summary, {
    article: sourceArticle,
    mineruPayload,
    jsonAssets: parsed.visuals.map((visual) => visual.path),
    markdownAssets: markdownImages.map((image) => image.asset_path),
    sourcePaths: new Set(extraction.files.keys())
  })));
  addAlias(files, canonicalPaths, aliases, "_extraction/manifest.json", LEGACY_MANIFEST_PATH);
  addAlias(files, canonicalPaths, aliases, "_extraction/validation.json", LEGACY_VALIDATION_PATH);

  const validation: AfterMinerUValidation = {
    schema_version: AFTER_MINERU_VALIDATION_VERSION,
    status: "passed",
    algorithm_version: AFTER_MINERU_REPAIR_ALGORITHM_VERSION,
    source_archive_sha256: sourceArchiveRecord.sha256,
    checks: {
      source_bytes_preserved: true,
      derived_article_bound: true,
      sidecars_bound: true,
      compatibility_aliases_bound: true
    },
    summary: {
      source_file_count: sourceRecords.length,
      derived_file_count: 1,
      sidecar_file_count: [...files.keys()].filter((path) => path.startsWith("sidecars/")).length + 1,
      compatibility_alias_count: aliases.length,
      repaired_visual_count: repairedVisualCount,
      review_candidate_count: reviewCandidateCount,
      unresolved_text_replacement_count: unresolvedTextReplacementCount
    }
  };
  addFile(files, canonicalPaths, VALIDATION_PATH, jsonBytes(validation));
  const sidecarPaths = [...files.keys()].filter((path) => path.startsWith("sidecars/"));
  const manifest: AfterMinerUManifest = {
    schema_version: AFTER_MINERU_PACKAGE_VERSION,
    algorithm_version: AFTER_MINERU_REPAIR_ALGORITHM_VERSION,
    source: {
      archive_path: SOURCE_ARCHIVE_PATH,
      article_path: sourceArticlePath,
      content_list_path: sourceContentListPath,
      pdf_path: selectedPdf?.path ?? null,
      files: sourceRecords
    },
    derived: { article_path: DERIVED_ARTICLE_PATH, files: [derivedArticleRecord] },
    sidecars: {
      reader_projection_path: READER_PROJECTION_PATH,
      viewer_index_path: VIEWER_INDEX_PATH,
      visual_repair_path: VISUAL_REPAIR_PATH,
      visual_candidates_path: VISUAL_CANDIDATES_PATH,
      display_repair_path: displayRepairContract === undefined ? null : DISPLAY_REPAIR_PATH,
      provenance_path: PROVENANCE_PATH,
      validation_path: VALIDATION_PATH,
      files: sortedRecords(sidecarPaths, files)
    },
    compatibility: { profile: "paper2md-reader-v0.1.3", aliases }
  };
  addFile(files, canonicalPaths, AFTER_MINERU_MANIFEST_PATH, jsonBytes(manifest));
  emitProgress(options, "verify-package", 86);
  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(files));
  checkpoint(options);
  return {
    archiveName: `${safeArchiveStem(archiveName)}.after-mineru.zip`,
    files,
    manifest,
    validation,
    readerProjection,
    report,
    summary
  };
}

export async function repairMinerUArchive(input: RepairMinerUArchiveInput): Promise<RepairMinerUArchiveResult> {
  return await runRepairMinerUArchive(input);
}

export async function buildAfterMinerUArchive(
  input: RepairMinerUArchiveInput,
  options?: RepairExecutionOptions
): Promise<BuiltAfterMinerUArchive> {
  const repaired = await runRepairMinerUArchive(input, options);
  emitProgress(options, "compress-package", 94);
  const archiveBytes = await zipAfterMinerUPackage(repaired.files);
  emitProgress(options, "complete", 100);
  return { ...repaired, archiveBytes };
}

export async function buildAfterMinerUExports(
  input: RepairMinerUArchiveInput,
  options?: RepairExecutionOptions
): Promise<BuiltAfterMinerUExports> {
  const repaired = await runRepairMinerUArchive(input, options);
  emitProgress(options, "build-portable-export", 89);
  let portableMarkdown: PortableMarkdownExportOutcome;
  try {
    emitProgress(options, "compress-portable-export", 92);
    portableMarkdown = {
      status: "ready",
      output: await buildPortableMarkdownExport({
        archiveName: repaired.archiveName,
        verifiedPackageFiles: repaired.files,
        manifest: repaired.manifest,
        readerProjection: repaired.readerProjection
      })
    };
  } catch (error) {
    if (!(error instanceof PortableMarkdownUnavailableError)) throw error;
    portableMarkdown = { status: "unavailable", reason: error.reason };
  }
  checkpoint(options);
  emitProgress(options, "compress-verified-package", 96);
  const archiveBytes = await zipAfterMinerUPackage(repaired.files);
  emitProgress(options, "complete", 100);
  return {
    verifiedPackage: { ...repaired, archiveBytes },
    portableMarkdown
  };
}

export async function zipAfterMinerUPackage(files: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  const snapshot = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
  await validateAfterMinerUPackage(mapAfterMinerUPackageReader(snapshot));
  const entries = Object.create(null) as Zippable;
  for (const [path, bytes] of [...snapshot].sort(([left], [right]) => compareCodeUnits(left, right))) {
    entries[path] = [bytes, { level: 6, mtime: FIXED_ZIP_MTIME }];
  }
  return zipSync(entries, { level: 6 });
}
