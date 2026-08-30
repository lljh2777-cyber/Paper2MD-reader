import type { RepairProgress } from "../../../packages/repair-core/src/index";
import {
  REPAIR_WORKER_PROTOCOL,
  hasRepairWorkerEnvelope,
  isRepairWorkerResponse,
  type RepairWorkerCancelMessage,
  type RepairWorkerStartMessage,
  type RepairWorkerSuccessMessage
} from "./repair-worker-protocol";

const REPAIR_WORKER_TIMEOUT_MS = 180_000;
let requestSequence = 0;

export interface BrowserRepairInput {
  archive: File;
  sourcePdf?: File;
}

export interface BrowserRepairOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RepairProgress) => void;
}

export type BrowserRepairResult = RepairWorkerSuccessMessage["result"];

export class BrowserRepairCancelledError extends Error {
  constructor() {
    super("本次修复已取消；源文件未被修改。");
    this.name = "BrowserRepairCancelledError";
  }
}

function nextRequestId(): string {
  requestSequence += 1;
  return `repair-${requestSequence}`;
}

export async function runBrowserRepair(
  input: BrowserRepairInput,
  options: BrowserRepairOptions = {}
): Promise<BrowserRepairResult> {
  if (options.signal?.aborted) throw new BrowserRepairCancelledError();
  const [archiveBytes, sourcePdfBytes] = await Promise.all([
    input.archive.arrayBuffer(),
    input.sourcePdf ? input.sourcePdf.arrayBuffer() : Promise.resolve(undefined)
  ]);
  if (options.signal?.aborted) throw new BrowserRepairCancelledError();

  const requestId = nextRequestId();
  const worker = new Worker(new URL("./repair-worker.ts", import.meta.url), { type: "module" });
  const message: RepairWorkerStartMessage = {
    protocol: REPAIR_WORKER_PROTOCOL,
    type: "start",
    requestId,
    archive: { bytes: archiveBytes, name: input.archive.name },
    sourcePdf: input.sourcePdf && sourcePdfBytes
      ? { bytes: sourcePdfBytes, name: input.sourcePdf.name }
      : undefined
  };
  const transfer: ArrayBuffer[] = [archiveBytes];
  if (sourcePdfBytes) transfer.push(sourcePdfBytes);

  return await new Promise<BrowserRepairResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = (): void => {
      const cancel: RepairWorkerCancelMessage = {
        protocol: REPAIR_WORKER_PROTOCOL,
        type: "cancel",
        requestId
      };
      try {
        worker.postMessage(cancel);
      } catch {
        // terminate() below is the strong cancellation boundary.
      }
      finish(() => reject(new BrowserRepairCancelledError()));
    };
    timeout = setTimeout(() => {
      finish(() => reject(new Error("本地修复超时；源文件未被修改，也没有生成半成品。")));
    }, REPAIR_WORKER_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", () => {
      finish(() => reject(new Error("Repair Worker 未能启动；源文件未被修改。")));
    }, { once: true });
    worker.addEventListener("messageerror", () => {
      finish(() => reject(new Error("Repair Worker 返回了无法读取的数据。")));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!hasRepairWorkerEnvelope(event.data, requestId)) return;
      if (!isRepairWorkerResponse(event.data, requestId)) {
        finish(() => reject(new Error("Repair Worker 返回了不符合协议的数据。")));
        return;
      }
      const response = event.data;
      if (response.type === "progress") {
        try {
          options.onProgress?.(response.progress);
        } catch {
          // UI observers must not interrupt a verified background repair.
        }
        return;
      }
      if (response.type === "error") {
        finish(() => reject(response.code === "cancelled"
          ? new BrowserRepairCancelledError()
          : new Error(response.error || "After-MinerU 修复失败。")));
        return;
      }
      finish(() => resolve(response.result));
    });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage(message, transfer);
    } catch (error) {
      finish(() => reject(new Error(error instanceof Error
        ? `Repair Worker 无法接收输入：${error.message}`
        : "Repair Worker 无法接收输入。")));
    }
  });
}
