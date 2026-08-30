import type {
  AfterMinerURepairReport,
  RepairMinerUArchiveSummary,
  RepairProgress
} from "../../../packages/repair-core/src/index";

export const REPAIR_WORKER_PROTOCOL = "after-mineru-repair-worker-v1" as const;

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
    archiveBytes: ArrayBuffer;
    archiveName: string;
    fileCount: number;
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
  "compress-package",
  "complete"
]);

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
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
    return Boolean(progress)
      && typeof progress!.stage === "string"
      && PROGRESS_STAGES.has(progress!.stage)
      && typeof progress!.percent === "number"
      && Number.isInteger(progress!.percent)
      && progress!.percent >= 0
      && progress!.percent <= 100;
  }
  if (message.type === "success") {
    const result = record(message.result);
    return Boolean(result)
      && typeof result!.algorithmVersion === "string"
      && result!.archiveBytes instanceof ArrayBuffer
      && typeof result!.archiveName === "string"
      && Number.isSafeInteger(result!.fileCount)
      && typeof result!.sourceSha256 === "string"
      && Boolean(record(result!.report))
      && Boolean(record(result!.summary));
  }
  if (message.type === "error") {
    return (message.code === "cancelled" || message.code === "repair-failed")
      && typeof message.error === "string";
  }
  return false;
}
