import {
  buildAfterMinerUArchive,
  RepairExecutionCancelledError
} from "../../../packages/repair-core/src/index";
import {
  REPAIR_WORKER_PROTOCOL,
  type RepairWorkerRequest,
  type RepairWorkerResponse,
  type RepairWorkerStartMessage
} from "./repair-worker-protocol";

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<RepairWorkerRequest>) => void): void;
  postMessage(message: RepairWorkerResponse, transfer?: Transferable[]): void;
};

let activeRequest: { id: string; controller: AbortController } | undefined;

function post(message: RepairWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

async function runRepair(message: RepairWorkerStartMessage): Promise<void> {
  if (activeRequest) {
    post({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "error",
      requestId: message.requestId,
      code: "repair-failed",
      error: "Repair Worker is already processing another request"
    });
    return;
  }
  const controller = new AbortController();
  activeRequest = { id: message.requestId, controller };
  try {
    const result = await buildAfterMinerUArchive({
      archiveBytes: new Uint8Array(message.archive.bytes),
      archiveName: message.archive.name,
      sourcePdf: message.sourcePdf
        ? { bytes: new Uint8Array(message.sourcePdf.bytes), name: message.sourcePdf.name }
        : undefined
    }, {
      signal: controller.signal,
      onProgress(progress) {
        post({
          protocol: REPAIR_WORKER_PROTOCOL,
          type: "progress",
          requestId: message.requestId,
          progress
        });
      }
    });
    if (controller.signal.aborted) throw new RepairExecutionCancelledError();
    const archiveBytes = result.archiveBytes.buffer.slice(
      result.archiveBytes.byteOffset,
      result.archiveBytes.byteOffset + result.archiveBytes.byteLength
    ) as ArrayBuffer;
    post({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "success",
      requestId: message.requestId,
      result: {
        algorithmVersion: result.manifest.algorithm_version,
        archiveBytes,
        archiveName: result.archiveName,
        fileCount: result.files.size,
        report: result.report,
        sourceSha256: result.validation.source_archive_sha256,
        summary: result.summary
      }
    }, [archiveBytes]);
  } catch (error) {
    const cancelled = controller.signal.aborted || error instanceof RepairExecutionCancelledError;
    post({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "error",
      requestId: message.requestId,
      code: cancelled ? "cancelled" : "repair-failed",
      error: cancelled
        ? "After-MinerU repair was cancelled"
        : error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (activeRequest?.id === message.requestId) activeRequest = undefined;
  }
}

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.protocol !== REPAIR_WORKER_PROTOCOL) return;
  if (message.type === "cancel") {
    if (activeRequest?.id === message.requestId) activeRequest.controller.abort();
    return;
  }
  void runRepair(message);
});
