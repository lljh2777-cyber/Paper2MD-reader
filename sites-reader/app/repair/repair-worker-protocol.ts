import type {
  AfterMinerURepairReport,
  PortableMarkdownRepresentation,
  PortableMarkdownUnavailableReason,
  PortableMarkdownWarning,
  RepairMinerUArchiveSummary,
  RepairProgress
} from "../../../packages/repair-core/src/index";

export const REPAIR_WORKER_PROTOCOL = "after-mineru-repair-worker-v2" as const;

export interface RepairWorkerStartMessage {
  protocol: typeof REPAIR_WORKER_PROTOCOL;
  type: "start";
  requestId: string;
  archive: { bytes: ArrayBuffer; name: string };
  sourcePdf?: { bytes: ArrayBuffer; name: string };
}

export interface RepairWorkerCancelMessage {
  protocol: typeof REPAIR_WORKER_PROTOCOL;
  type: "cancel";
  requestId: string;
}

export type RepairWorkerRequest = RepairWorkerStartMessage | RepairWorkerCancelMessage;

export interface RepairWorkerProgressMessage {
  protocol: typeof REPAIR_WORKER_PROTOCOL;
  type: "progress";
  requestId: string;
  progress: RepairProgress;
}

export interface RepairWorkerSuccessMessage {
  protocol: typeof REPAIR_WORKER_PROTOCOL;
  type: "success";
  requestId: string;
  result: {
    algorithmVersion: string;
    outputs: {
      markdownZip:
        | {
          status: "ready";
          bytes: ArrayBuffer;
          name: string;
          fileCount: number;
          representation: PortableMarkdownRepresentation;
          warnings: PortableMarkdownWarning[];
        }
        | {
          status: "unavailable";
          reason: PortableMarkdownUnavailableReason;
        };
      verifiedPackage: {
        bytes: ArrayBuffer;
        name: string;
        fileCount: number;
      };
    };
    report: AfterMinerURepairReport;
    sourceSha256: string;
    summary: RepairMinerUArchiveSummary;
  };
}

export interface RepairWorkerErrorMessage {
  protocol: typeof REPAIR_WORKER_PROTOCOL;
  type: "error";
  requestId: string;
  code: "cancelled" | "repair-failed";
  error: string;
}

export type RepairWorkerResponse =
  | RepairWorkerProgressMessage
  | RepairWorkerSuccessMessage
  | RepairWorkerErrorMessage;

type UnknownRecord = Record<string, unknown>;

const PROGRESS_STAGES = new Set([
  "inspect-source",
  "parse-content",
  "analyze-visuals",
  "materialize-derived",
  "bind-package",
  "verify-package",
  "build-portable-export",
  "compress-portable-export",
  "compress-verified-package",
  "compress-package",
  "complete"
]);

const REPAIR_WARNING_CODES = new Set([
  "source-pdf-unavailable",
  "review-candidates-present",
  "unresolved-text-replacements"
]);
const PORTABLE_WARNING_CODES = new Set([
  "pdf-crop-not-materialized",
  "fragment-set-not-materialized"
]);
const PORTABLE_UNAVAILABLE_REASONS = new Set([
  "reader-slots-not-materialized",
  "unsupported-image-syntax",
  "unsafe-asset-reference",
  "missing-source-asset",
  "fallback-assets-incomplete",
  "portable-size-limit-exceeded",
  "portable-archive-validation-failed"
]);
const SHA256_RE = /^[a-f0-9]{64}$/;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function zipName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 4
    && value.length <= 255
    && value === value.trim()
    && /\.zip$/i.test(value)
    && !/[\\/\u0000-\u001f]/u.test(value);
}

function outputFile(value: unknown): boolean {
  const output = record(value);
  return Boolean(output)
    && exactKeys(output!, ["bytes", "name", "fileCount"])
    && output!.bytes instanceof ArrayBuffer
    && output!.bytes.byteLength > 0
    && zipName(output!.name)
    && positiveInteger(output!.fileCount);
}

function warnings(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (!Array.isArray(value)) return false;
  const codes = new Set<string>();
  return value.every((entry) => {
    const warning = record(entry);
    const code = typeof warning?.code === "string" ? warning.code : "";
    if (codes.has(code)) return false;
    codes.add(code);
    return Boolean(warning)
      && exactKeys(warning!, ["code", "count"])
      && typeof warning!.code === "string"
      && allowed.has(warning!.code)
      && positiveInteger(warning!.count);
  });
}

function repairSummary(value: unknown): value is UnknownRecord {
  const summary = record(value);
  return Boolean(summary)
    && exactKeys(summary!, [
      "sourceFileCount",
      "sourceImageCount",
      "visibleVisualCount",
      "repairedVisualCount",
      "reviewCandidateCount",
      "unresolvedTextReplacementCount",
      "sourcePdfIncluded"
    ])
    && nonNegativeInteger(summary!.sourceFileCount)
    && nonNegativeInteger(summary!.sourceImageCount)
    && nonNegativeInteger(summary!.visibleVisualCount)
    && nonNegativeInteger(summary!.repairedVisualCount)
    && nonNegativeInteger(summary!.reviewCandidateCount)
    && nonNegativeInteger(summary!.unresolvedTextReplacementCount)
    && typeof summary!.sourcePdfIncluded === "boolean";
}

function repairReport(value: unknown, summary: UnknownRecord, algorithmVersion: string, sourceSha256: string): boolean {
  const report = record(value);
  const checks = record(report?.checks);
  const reportSummary = record(report?.summary);
  return Boolean(report && checks && reportSummary)
    && exactKeys(report!, [
      "schema_version",
      "contract",
      "algorithm_version",
      "status",
      "source_archive_sha256",
      "derived_article_sha256",
      "source_pdf_included",
      "checks",
      "summary",
      "warnings"
    ])
    && exactKeys(checks!, [
      "source_archive_validated",
      "source_tree_bound",
      "derived_article_materialized",
      "reader_projection_bound",
      "compatibility_profile_generated"
    ])
    && exactKeys(reportSummary!, [
      "source_file_count",
      "source_image_count",
      "visible_visual_count",
      "repaired_visual_count",
      "review_candidate_count",
      "unresolved_text_replacement_count"
    ])
    && report!.schema_version === 1
    && report!.contract === "after-mineru-repair-report-v1"
    && report!.status === "passed"
    && report!.algorithm_version === algorithmVersion
    && report!.source_archive_sha256 === sourceSha256
    && typeof report!.derived_article_sha256 === "string"
    && SHA256_RE.test(report!.derived_article_sha256)
    && report!.source_pdf_included === summary.sourcePdfIncluded
    && checks!.source_archive_validated === true
    && checks!.source_tree_bound === true
    && checks!.derived_article_materialized === true
    && checks!.reader_projection_bound === true
    && checks!.compatibility_profile_generated === true
    && reportSummary!.source_file_count === summary.sourceFileCount
    && reportSummary!.source_image_count === summary.sourceImageCount
    && reportSummary!.visible_visual_count === summary.visibleVisualCount
    && reportSummary!.repaired_visual_count === summary.repairedVisualCount
    && reportSummary!.review_candidate_count === summary.reviewCandidateCount
    && reportSummary!.unresolved_text_replacement_count === summary.unresolvedTextReplacementCount
    && warnings(report!.warnings, REPAIR_WARNING_CODES);
}

function markdownOutput(value: unknown): boolean {
  const output = record(value);
  if (!output) return false;
  if (output.status === "unavailable") {
    return exactKeys(output, ["status", "reason"])
      && typeof output.reason === "string"
      && PORTABLE_UNAVAILABLE_REASONS.has(output.reason);
  }
  const file = { bytes: output.bytes, name: output.name, fileCount: output.fileCount };
  const representation = output.representation;
  const validWarnings = warnings(output.warnings, PORTABLE_WARNING_CODES);
  return output.status === "ready"
    && exactKeys(output, ["status", "bytes", "name", "fileCount", "representation", "warnings"])
    && outputFile(file)
    && (representation === "portable-derived" || representation === "source-assets-fallback")
    && validWarnings
    && Array.isArray(output.warnings)
    && ((representation === "portable-derived" && output.warnings.length === 0)
      || (representation === "source-assets-fallback" && output.warnings.length > 0));
}

export function hasRepairWorkerEnvelope(value: unknown, requestId: string): boolean {
  const message = record(value);
  return message?.protocol === REPAIR_WORKER_PROTOCOL && message.requestId === requestId;
}

export function isRepairWorkerResponse(value: unknown, requestId: string): value is RepairWorkerResponse {
  const message = record(value);
  if (!message || !hasRepairWorkerEnvelope(message, requestId)) return false;
  if (message.type === "progress") {
    const progress = record(message.progress);
    return exactKeys(message, ["protocol", "type", "requestId", "progress"])
      && Boolean(progress)
      && exactKeys(progress!, ["stage", "percent"])
      && typeof progress!.stage === "string"
      && PROGRESS_STAGES.has(progress!.stage)
      && typeof progress!.percent === "number"
      && Number.isInteger(progress!.percent)
      && progress!.percent >= 0
      && progress!.percent <= 100;
  }
  if (message.type === "success") {
    const result = record(message.result);
    const outputs = record(result?.outputs);
    const summary = repairSummary(result?.summary) ? record(result!.summary)! : undefined;
    return Boolean(result && outputs && summary)
      && exactKeys(message, ["protocol", "type", "requestId", "result"])
      && exactKeys(result!, ["algorithmVersion", "outputs", "report", "sourceSha256", "summary"])
      && exactKeys(outputs!, ["markdownZip", "verifiedPackage"])
      && typeof result!.algorithmVersion === "string"
      && result!.algorithmVersion.length > 0
      && typeof result!.sourceSha256 === "string"
      && SHA256_RE.test(result!.sourceSha256)
      && outputFile(outputs!.verifiedPackage)
      && markdownOutput(outputs!.markdownZip)
      && repairReport(result!.report, summary!, result!.algorithmVersion, result!.sourceSha256);
  }
  if (message.type === "error") {
    return exactKeys(message, ["protocol", "type", "requestId", "code", "error"])
      && (message.code === "cancelled" || message.code === "repair-failed")
      && typeof message.error === "string";
  }
  return false;
}
