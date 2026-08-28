import { ConversionTask, StartConversionRequest } from "../shared/desktop-api";
import { ReviewedLayoutOptions, ReviewedWorkflowPaths } from "./reviewed-workflow";

export const DESKTOP_TASK_STORE_VERSION = "paper2md-desktop-task-store-v0.1";
const TASK_STATES = new Set(["queued", "running", "awaiting-review", "succeeded", "failed", "cancelled"]);
const TASK_STAGES = new Set([
  "direct-convert",
  "remote-upload",
  "remote-extract",
  "remote-download",
  "remote-validate",
  "remote-publish",
  "roi-proposal",
  "roi-review",
  "layout-prepare",
  "layout-review",
  "layout-validation",
  "layout-apply",
  "complete"
]);

export type PersistentConversionTask = Omit<
  ConversionTask,
  "packageRootId" | "artifactRootId" | "packageId" | "recovered"
>;

export interface PersistedDirectJob {
  kind: "direct";
  pdfPath: string;
  outputPath: string;
  request: Pick<StartConversionRequest, "backend" | "regionRenderMode">;
}

export interface PersistedReviewedJob {
  kind: "reviewed-layout";
  pdfPath: string;
  paths: ReviewedWorkflowPaths;
  options: ReviewedLayoutOptions;
}

export interface PersistedRemoteMineruJob {
  kind: "mineru-remote";
  packageId: string;
}

export type PersistedDesktopJob = PersistedDirectJob | PersistedReviewedJob | PersistedRemoteMineruJob;

export interface PersistedTaskEntry {
  task: PersistentConversionTask;
  job: PersistedDesktopJob;
}

export interface ParsedTaskStore {
  entries: PersistedTaskEntry[];
  diagnostics: string[];
}

export interface ReviewedRecoveryEvidence {
  outputReady: boolean;
  outputExists: boolean;
  layoutReviewReady: boolean;
  confirmedRoiReady: boolean;
  roiProposalReady: boolean;
}

export type ReviewedRecoveryPoint =
  | "complete"
  | "partial-output"
  | "layout-review"
  | "layout-prepare"
  | "roi-review"
  | "roi-proposal";

export function reviewedRecoveryPoint(evidence: ReviewedRecoveryEvidence): ReviewedRecoveryPoint {
  if (evidence.outputReady) return "complete";
  if (evidence.outputExists) return "partial-output";
  if (evidence.layoutReviewReady) return "layout-review";
  if (evidence.confirmedRoiReady) return "layout-prepare";
  if (evidence.roiProposalReady) return "roi-review";
  return "roi-proposal";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function parseTask(value: unknown): PersistentConversionTask | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (
    !boundedString(candidate.id, 128) ||
    !boundedString(candidate.pdfName, 1024) ||
    !boundedString(candidate.outputName, 4096) ||
    !["direct", "reviewed-layout", "mineru-remote"].includes(String(candidate.workflow)) ||
    !TASK_STAGES.has(String(candidate.stage)) ||
    !TASK_STATES.has(String(candidate.state)) ||
    !boundedString(candidate.createdAt, 128) ||
    !boundedString(candidate.updatedAt, 128) ||
    !boundedString(candidate.message, 64 * 1024) ||
    !Number.isFinite(Date.parse(String(candidate.createdAt))) ||
    !Number.isFinite(Date.parse(String(candidate.updatedAt)))
  ) {
    return undefined;
  }
  if (candidate.artifactLabel !== undefined && !boundedString(candidate.artifactLabel, 1024)) return undefined;
  if (candidate.errorCode !== undefined && (
    !boundedString(candidate.errorCode, 128) || !/^[A-Z0-9_-]+$/u.test(candidate.errorCode)
  )) return undefined;
  return {
    id: candidate.id,
    pdfName: candidate.pdfName,
    outputName: candidate.outputName,
    workflow: candidate.workflow as PersistentConversionTask["workflow"],
    stage: candidate.stage as PersistentConversionTask["stage"],
    state: candidate.state as PersistentConversionTask["state"],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    message: candidate.message,
    ...(candidate.errorCode ? { errorCode: candidate.errorCode as string } : {}),
    ...(candidate.artifactLabel ? { artifactLabel: candidate.artifactLabel as string } : {})
  };
}

function parseReviewedOptions(value: unknown): ReviewedLayoutOptions | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.backend !== "pdfium" ||
    !["fast", "standard", "forensic"].includes(String(candidate.extractionProfile)) ||
    !["visual-direct", "candidate-assisted"].includes(String(candidate.reviewMode)) ||
    !["keep", "omit", "separate"].includes(String(candidate.references)) ||
    !["minimal", "standard", "full"].includes(String(candidate.evidence)) ||
    typeof candidate.includeSourcePdf !== "boolean"
  ) return undefined;
  return candidate as unknown as ReviewedLayoutOptions;
}

function parseReviewedPaths(value: unknown): ReviewedWorkflowPaths | undefined {
  const candidate = record(value);
  const keys: Array<keyof ReviewedWorkflowPaths> = [
    "workspacePath",
    "roiProposalPath",
    "confirmedRoiPath",
    "layoutReviewPath",
    "outputPath",
    "outputName"
  ];
  if (!candidate || keys.some((key) => !boundedString(candidate[key], 32768))) return undefined;
  return candidate as unknown as ReviewedWorkflowPaths;
}

function parseJob(value: unknown): PersistedDesktopJob | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (candidate.kind === "mineru-remote") {
    if (!boundedString(candidate.packageId, 128)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.packageId)) {
      return undefined;
    }
    return { kind: "mineru-remote", packageId: candidate.packageId };
  }
  if (!boundedString(candidate.pdfPath, 32768)) return undefined;
  if (candidate.kind === "direct") {
    const request = record(candidate.request);
    if (
      !boundedString(candidate.outputPath, 32768) ||
      !request ||
      request.backend !== "pdfium" ||
      !["off", "auto"].includes(String(request.regionRenderMode))
    ) return undefined;
    return {
      kind: "direct",
      pdfPath: candidate.pdfPath,
      outputPath: candidate.outputPath,
      request: { backend: "pdfium", regionRenderMode: request.regionRenderMode as "off" | "auto" }
    };
  }
  if (candidate.kind === "reviewed-layout") {
    const paths = parseReviewedPaths(candidate.paths);
    const options = parseReviewedOptions(candidate.options);
    if (!paths || !options) return undefined;
    return { kind: "reviewed-layout", pdfPath: candidate.pdfPath, paths, options };
  }
  return undefined;
}

export function parseTaskStoreJson(text: string): ParsedTaskStore {
  const value = JSON.parse(text) as unknown;
  const root = record(value);
  if (!root || root.contract_version !== DESKTOP_TASK_STORE_VERSION || !Array.isArray(root.entries)) {
    throw new Error("Desktop task store contract is invalid");
  }
  if (root.entries.length > 500) throw new Error("Desktop task store exceeds the 500 task limit");
  const entries: PersistedTaskEntry[] = [];
  const diagnostics: string[] = [];
  root.entries.forEach((rawEntry, index) => {
    const entry = record(rawEntry);
    const task = parseTask(entry?.task);
    const job = parseJob(entry?.job);
    if (!task || !job || task.workflow !== job.kind) {
      diagnostics.push(`Ignored invalid task entry ${index + 1}`);
      return;
    }
    entries.push({ task, job });
  });
  return { entries, diagnostics };
}

export function taskStoreJson(entries: PersistedTaskEntry[]): string {
  return `${JSON.stringify({
    contract_version: DESKTOP_TASK_STORE_VERSION,
    entries: entries.slice(0, 500)
  }, null, 2)}\n`;
}

export function persistentTask(task: ConversionTask): PersistentConversionTask {
  const {
    packageRootId: _packageRootId,
    artifactRootId: _artifactRootId,
    packageId: _packageId,
    recovered: _recovered,
    ...value
  } = task;
  return value;
}
