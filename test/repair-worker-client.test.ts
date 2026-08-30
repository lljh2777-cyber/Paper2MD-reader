import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AfterMinerURepairReport,
  RepairMinerUArchiveSummary
} from "../packages/repair-core/src/index";
import {
  BrowserRepairCancelledError,
  runBrowserRepair
} from "../sites-reader/app/repair/repair-worker-client";
import { REPAIR_WORKER_PROTOCOL } from "../sites-reader/app/repair/repair-worker-protocol";

type WorkerListener = (event: { data?: unknown }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly listeners = new Map<string, Set<WorkerListener>>();
  readonly posts: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  terminateCount = 0;

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const summary: RepairMinerUArchiveSummary = {
  sourceFileCount: 4,
  sourceImageCount: 1,
  visibleVisualCount: 1,
  repairedVisualCount: 1,
  reviewCandidateCount: 0,
  unresolvedTextReplacementCount: 0,
  sourcePdfIncluded: false
};

const report: AfterMinerURepairReport = {
  schema_version: 1,
  contract: "after-mineru-repair-report-v1",
  algorithm_version: "after-mineru-visual-repair-v1",
  status: "passed",
  source_archive_sha256: "a".repeat(64),
  derived_article_sha256: "b".repeat(64),
  source_pdf_included: false,
  checks: {
    source_archive_validated: true,
    source_tree_bound: true,
    derived_article_materialized: true,
    reader_projection_bound: true,
    compatibility_profile_generated: true
  },
  summary: {
    source_file_count: 4,
    source_image_count: 1,
    visible_visual_count: 1,
    repaired_visual_count: 1,
    review_candidate_count: 0,
    unresolved_text_replacement_count: 0
  },
  warnings: []
};

function file(name: string, bytes: ArrayBuffer): File {
  return { name, arrayBuffer: async () => bytes } as File;
}

async function activeWorker(): Promise<FakeWorker> {
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  return FakeWorker.instances[0]!;
}

function startRequest(worker: FakeWorker): { requestId: string } {
  return worker.posts[0]!.message as { requestId: string };
}

describe("Repair browser Worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("transfers source buffers, forwards progress, and returns one final ZIP buffer", async () => {
    const archiveBytes = new Uint8Array([1, 2, 3]).buffer;
    const pdfBytes = new Uint8Array([4, 5]).buffer;
    const outputBytes = new Uint8Array([80, 75, 3, 4]).buffer;
    const progress: number[] = [];
    const resultPromise = runBrowserRepair({
      archive: file("paper.mineru.zip", archiveBytes),
      sourcePdf: file("paper.pdf", pdfBytes)
    }, {
      onProgress(value) { progress.push(value.percent); }
    });
    const worker = await activeWorker();
    const request = startRequest(worker);

    expect(worker.posts[0]!.transfer).toEqual([archiveBytes, pdfBytes]);
    expect(worker.posts[0]!.message).toEqual(expect.objectContaining({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "start",
      archive: { bytes: archiveBytes, name: "paper.mineru.zip" },
      sourcePdf: { bytes: pdfBytes, name: "paper.pdf" }
    }));

    worker.emit("message", {
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "progress",
      requestId: request.requestId,
      progress: { stage: "analyze-visuals", percent: 34 }
    });
    worker.emit("message", {
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      result: {
        algorithmVersion: report.algorithm_version,
        archiveBytes: outputBytes,
        archiveName: "paper.after-mineru.zip",
        fileCount: 12,
        report,
        sourceSha256: report.source_archive_sha256,
        summary
      }
    });

    await expect(resultPromise).resolves.toEqual(expect.objectContaining({ archiveBytes: outputBytes }));
    expect(progress).toEqual([34]);
    expect(worker.terminateCount).toBe(1);
  });

  it("uses terminate as the strong cancellation boundary and ignores late success", async () => {
    const controller = new AbortController();
    const resultPromise = runBrowserRepair({
      archive: file("paper.zip", new Uint8Array([1]).buffer)
    }, { signal: controller.signal });
    const worker = await activeWorker();
    const request = startRequest(worker);

    controller.abort();
    await expect(resultPromise).rejects.toBeInstanceOf(BrowserRepairCancelledError);
    expect(worker.posts.at(-1)?.message).toEqual({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "cancel",
      requestId: request.requestId
    });
    expect(worker.terminateCount).toBe(1);

    worker.emit("message", {
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      result: {}
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("does not create a Worker for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runBrowserRepair({
      archive: file("paper.zip", new Uint8Array([1]).buffer)
    }, { signal: controller.signal })).rejects.toBeInstanceOf(BrowserRepairCancelledError);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("fails closed on a malformed response for the active request", async () => {
    const resultPromise = runBrowserRepair({
      archive: file("paper.zip", new Uint8Array([1]).buffer)
    });
    const worker = await activeWorker();
    const request = startRequest(worker);
    worker.emit("message", {
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "success",
      requestId: "another-request",
      result: {}
    });
    worker.emit("message", {
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      result: {}
    });
    await expect(resultPromise).rejects.toThrow("不符合协议");
    expect(worker.terminateCount).toBe(1);
  });

  it("terminates a Worker that exceeds the repair watchdog", async () => {
    vi.useFakeTimers();
    const resultPromise = runBrowserRepair({
      archive: file("paper.zip", new Uint8Array([1]).buffer)
    });
    await Promise.resolve();
    await Promise.resolve();
    const worker = FakeWorker.instances[0]!;
    expect(worker).toBeDefined();
    const rejection = expect(resultPromise).rejects.toThrow("本地修复超时");
    await vi.advanceTimersByTimeAsync(180_000);
    await rejection;
    expect(worker.terminateCount).toBe(1);
  });
});
