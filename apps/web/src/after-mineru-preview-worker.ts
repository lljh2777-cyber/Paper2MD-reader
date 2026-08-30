import {
  AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
  isAfterMinerUPreviewWorkerStart,
  type AfterMinerUPreviewWorkerResponse
} from "./after-mineru-preview-worker-protocol";
import { validateAfterMinerUPreviewArchive } from "./after-mineru-preview-worker-core";

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: AfterMinerUPreviewWorkerResponse, transfer?: Transferable[]): void;
};

let started = false;

workerScope.addEventListener("message", (event) => {
  const value = event.data;
  if (!isAfterMinerUPreviewWorkerStart(value) || started) return;
  started = true;
  void validateAfterMinerUPreviewArchive(value.archiveBytes, value.expectedFileCount)
    .then((entries) => {
      workerScope.postMessage({
        protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
        type: "success",
        requestId: value.requestId,
        fileCount: entries.length,
        entries
      }, entries.map((entry) => entry.data));
    })
    .catch((error: unknown) => {
      workerScope.postMessage({
        protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
        type: "error",
        requestId: value.requestId,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "After-MinerU preview validation failed."
      });
    });
});
