import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAfterMinerUArchive } from "../packages/repair-core/src/index";
import { AFTER_MINERU_MANIFEST_PATH } from "../packages/after-mineru-contract/src/index";
import {
  AfterMinerUPreviewImportCancelledError,
  importAfterMinerUPreviewWithWorker
} from "../apps/web/src/after-mineru-preview-worker-client";
import { validateAfterMinerUPreviewArchive } from "../apps/web/src/after-mineru-preview-worker-core";
import {
  AFTER_MINERU_PREVIEW_TOTAL_BYTES,
  AFTER_MINERU_PREVIEW_WORKER_LIMITS,
  AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
  type AfterMinerUPreviewWorkerStart
} from "../apps/web/src/after-mineru-preview-worker-protocol";
import { PackageLoader } from "../src/model/package-loader";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

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

function activeWorker(): FakeWorker {
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error("Expected an active preview Worker");
  return worker;
}

function startRequest(worker: FakeWorker): AfterMinerUPreviewWorkerStart {
  return worker.posts[0]!.message as AfterMinerUPreviewWorkerStart;
}

describe("After-MinerU preview validation Worker", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("validates a package built from the real Debye MinerU ZIP and remains loadable by PackageLoader", async () => {
    const rawArchive = new Uint8Array(await readFile(resolve(
      "sites-reader",
      "public",
      "demo",
      "debyecalculator",
      "mineru-original.mineru.zip"
    )));
    const built = await buildAfterMinerUArchive({
      archiveBytes: rawArchive,
      archiveName: "debyecalculator.mineru.zip"
    });
    const archiveBuffer = built.archiveBytes.buffer.slice(
      built.archiveBytes.byteOffset,
      built.archiveBytes.byteOffset + built.archiveBytes.byteLength
    ) as ArrayBuffer;

    const transferred = await validateAfterMinerUPreviewArchive(archiveBuffer, built.files.size);
    const files = Object.fromEntries(transferred.map((entry) => [entry.path, new Uint8Array(entry.data)]));
    const loaded = await new PackageLoader(new MemoryReaderFileSystem(files)).loadDetected();

    expect(transferred).toHaveLength(built.files.size);
    expect(transferred.some((entry) => entry.path === AFTER_MINERU_MANIFEST_PATH)).toBe(true);
    expect(loaded.packageIntegrity).toBe("verified");
    expect(loaded.activeProjection?.kind).toBe("verified-derived");
    expect(AFTER_MINERU_PREVIEW_TOTAL_BYTES).toBe(256 * 1024 * 1024);
    expect(AFTER_MINERU_PREVIEW_WORKER_LIMITS.totalBytes).toBe(AFTER_MINERU_PREVIEW_TOTAL_BYTES);
    await expect(validateAfterMinerUPreviewArchive(archiveBuffer, built.files.size - 1))
      .rejects.toThrow(/handoff declared/);

    const corruptBeforeEocdPreflight = archiveBuffer.slice(0);
    new Uint8Array(corruptBeforeEocdPreflight).fill(0, 0, 4);
    await expect(validateAfterMinerUPreviewArchive(corruptBeforeEocdPreflight, built.files.size - 1))
      .rejects.toThrow(/handoff declared/);
  }, 90_000);

  it("transfers ownership to one Worker and builds an in-memory file system from an exact response", async () => {
    const archiveBytes = new Uint8Array(22).buffer;
    const promise = importAfterMinerUPreviewWithWorker(
      archiveBytes,
      "paper.after-mineru.zip",
      { expectedFileCount: 2 }
    );
    const worker = activeWorker();
    const request = startRequest(worker);
    const manifest = new TextEncoder().encode("{}").buffer;
    const article = new TextEncoder().encode("# Paper\n").buffer;

    expect(worker.posts[0]!.transfer).toEqual([archiveBytes]);
    expect(request).toEqual({
      protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
      type: "start",
      requestId: expect.stringMatching(/^after-mineru-preview-/),
      archiveBytes,
      expectedFileCount: 2
    });
    worker.emit("message", {
      protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      fileCount: 2,
      entries: [
        { path: AFTER_MINERU_MANIFEST_PATH, data: manifest },
        { path: "derived/article.after-mineru.md", data: article }
      ]
    });

    const fileSystem = await promise;
    expect(fileSystem.rootLabel).toBe("paper");
    expect(await fileSystem.exists(AFTER_MINERU_MANIFEST_PATH)).toBe(true);
    expect(new TextDecoder().decode(await fileSystem.readBinary("derived/article.after-mineru.md")))
      .toBe("# Paper\n");
    expect(worker.terminateCount).toBe(1);
    fileSystem.dispose();
  });

  it("terminates as the strong abort boundary and ignores a late success", async () => {
    const controller = new AbortController();
    const promise = importAfterMinerUPreviewWithWorker(
      new Uint8Array(22).buffer,
      "paper.after-mineru.zip",
      { expectedFileCount: 1, signal: controller.signal }
    );
    const worker = activeWorker();
    const request = startRequest(worker);

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(AfterMinerUPreviewImportCancelledError);
    expect(worker.terminateCount).toBe(1);
    const lateFileConstruction = vi.fn(() => {
      throw new Error("A settled preview must not materialize late Worker entries.");
    });
    vi.stubGlobal("File", lateFileConstruction);
    worker.emit("message", {
      protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      fileCount: 1,
      entries: [{ path: AFTER_MINERU_MANIFEST_PATH, data: new Uint8Array([1]).buffer }]
    });
    expect(worker.terminateCount).toBe(1);
    expect(lateFileConstruction).not.toHaveBeenCalled();
  });

  it("fails closed on malformed output and terminates on timeout", async () => {
    const malformed = importAfterMinerUPreviewWithWorker(
      new Uint8Array(22).buffer,
      "paper.after-mineru.zip",
      { expectedFileCount: 1 }
    );
    let worker = activeWorker();
    const request = startRequest(worker);
    worker.emit("message", {
      protocol: AFTER_MINERU_PREVIEW_WORKER_PROTOCOL,
      type: "success",
      requestId: request.requestId,
      fileCount: 1,
      entries: [{ path: "../manifest.json", data: new Uint8Array([1]).buffer }]
    });
    await expect(malformed).rejects.toThrow(/invalid response/);
    expect(worker.terminateCount).toBe(1);

    vi.useFakeTimers();
    const timedOut = importAfterMinerUPreviewWithWorker(
      new Uint8Array(22).buffer,
      "paper.after-mineru.zip",
      { expectedFileCount: 1, timeoutMs: 5 }
    );
    worker = FakeWorker.instances[1]!;
    const rejection = expect(timedOut).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(worker.terminateCount).toBe(1);
  });
});
