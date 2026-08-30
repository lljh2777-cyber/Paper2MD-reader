import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HandoffAcceptedMessage,
  ReaderPreviewHandoffError,
  REPAIR_READER_HANDOFF_LIMITS,
  REPAIR_READER_HANDOFF_PROTOCOL,
  ReaderPreviewMessageEvent,
  ReaderPreviewMessageListener,
  ReaderPreviewMessagePeer,
  ReaderPreviewReceiverEnvironment,
  ReaderPreviewSenderEnvironment,
  VerifiedPackageMessage,
  isHandoffAcceptedMessage,
  isHandoffRejectedMessage,
  isReaderReadyMessage,
  isVerifiedPackageMessage,
  parseReaderPreviewFragment,
  receiveVerifiedPackagePreview,
  sendVerifiedPackageToReader
} from "../sites-reader/lib/repair-reader-preview";

const ORIGIN = "https://after-mineru.example";
const HANDOFF_ID = "11".repeat(16);
const NONCE = "22".repeat(32);
const SESSION = { handoffId: HANDOFF_ID, nonce: NONCE };
const FRAGMENT = `#repair-preview=v1.${HANDOFF_ID}.${NONCE}`;

class Timers {
  private sequence = 0;
  readonly callbacks = new Map<number, () => void>();

  set = (callback: () => void): number => {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  };

  clear = (id: number): void => {
    this.callbacks.delete(id);
  };

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

function readyMessage(): unknown {
  return {
    protocol: REPAIR_READER_HANDOFF_PROTOCOL,
    type: "reader-ready",
    ...SESSION
  };
}

function archiveMessage(bytes = new ArrayBuffer(22), fileCount = 1): VerifiedPackageMessage {
  return {
    protocol: REPAIR_READER_HANDOFF_PROTOCOL,
    type: "verified-package",
    ...SESSION,
    archive: {
      kind: "after-mineru-verified-package",
      name: "paper.after-mineru.zip",
      byteLength: bytes.byteLength,
      fileCount,
      bytes
    }
  };
}

function acceptedMessage(): HandoffAcceptedMessage {
  return {
    protocol: REPAIR_READER_HANDOFF_PROTOCOL,
    type: "accepted",
    ...SESSION
  };
}

function senderHarness(openReader: (path: string) => ReaderPreviewMessagePeer | null) {
  const listeners = new Set<ReaderPreviewMessageListener>();
  const timers = new Timers();
  let now = 0;
  const environment: ReaderPreviewSenderEnvironment = {
    origin: ORIGIN,
    openReader,
    addMessageListener: (listener) => listeners.add(listener),
    removeMessageListener: (listener) => listeners.delete(listener),
    setTimer: (callback) => timers.set(callback),
    clearTimer: timers.clear,
    randomBytes(length) {
      return new Uint8Array(length).fill(length === 16 ? 0x11 : 0x22);
    },
    now: () => now
  };
  return {
    environment,
    listeners,
    timers,
    advance(milliseconds: number) { now += milliseconds; },
    dispatch(event: ReaderPreviewMessageEvent) {
      [...listeners].forEach((listener) => listener(event));
    }
  };
}

function receiverHarness(options: {
  hash?: string;
  onPost?: (message: unknown, targetOrigin: string) => void;
} = {}) {
  const listeners = new Set<ReaderPreviewMessageListener>();
  const timers = new Timers();
  const replaced: string[] = [];
  let detached = false;
  let now = 0;
  const opener: ReaderPreviewMessagePeer = {
    postMessage(message, targetOrigin) {
      options.onPost?.(message, targetOrigin);
    }
  };
  const environment: ReaderPreviewReceiverEnvironment = {
    origin: ORIGIN,
    hash: options.hash ?? FRAGMENT,
    pathAndQuery: "/reader",
    opener,
    addMessageListener: (listener) => listeners.add(listener),
    removeMessageListener: (listener) => listeners.delete(listener),
    replaceUrl: (path) => replaced.push(path),
    detachOpener: () => { detached = true; },
    setTimer: (callback) => timers.set(callback),
    clearTimer: timers.clear,
    now: () => now
  };
  return {
    environment,
    opener,
    listeners,
    timers,
    replaced,
    get detached() { return detached; },
    advance(milliseconds: number) { now += milliseconds; },
    dispatch(event: ReaderPreviewMessageEvent) {
      [...listeners].forEach((listener) => listener(event));
    }
  };
}

describe("Repair to Reader preview protocol", () => {
  it("parses only one exact v1 fragment and exact-key messages", () => {
    expect(parseReaderPreviewFragment("")).toEqual({ status: "absent" });
    expect(parseReaderPreviewFragment("#section-2")).toEqual({ status: "absent" });
    expect(parseReaderPreviewFragment(FRAGMENT)).toEqual({ status: "valid", ...SESSION });
    expect(parseReaderPreviewFragment(`${FRAGMENT}&extra=1`)).toEqual({ status: "invalid" });
    expect(parseReaderPreviewFragment(`#repair-preview=v2.${HANDOFF_ID}.${NONCE}`)).toEqual({ status: "invalid" });
    expect(parseReaderPreviewFragment(`#repair-preview=v1.${"AA".repeat(16)}.${NONCE}`)).toEqual({ status: "invalid" });

    const archive = archiveMessage();
    expect(isReaderReadyMessage(readyMessage(), SESSION)).toBe(true);
    expect(isReaderReadyMessage({ ...readyMessage() as object, extra: true }, SESSION)).toBe(false);
    expect(isReaderReadyMessage({ ...readyMessage() as object, nonce: "33".repeat(32) }, SESSION)).toBe(false);
    expect(isVerifiedPackageMessage(archive, SESSION)).toBe(true);
    expect(isVerifiedPackageMessage({ ...archive, archive: { ...archive.archive, byteLength: 23 } }, SESSION)).toBe(false);
    expect(isVerifiedPackageMessage({ ...archive, archive: { ...archive.archive, name: "../paper.after-mineru.zip" } }, SESSION)).toBe(false);
    expect(isVerifiedPackageMessage({ ...archive, archive: { ...archive.archive, fileCount: 2_049 } }, SESSION)).toBe(false);
    expect(isHandoffAcceptedMessage(acceptedMessage(), SESSION)).toBe(true);
    expect(isHandoffAcceptedMessage({ ...acceptedMessage(), extra: true }, SESSION)).toBe(false);
    expect(isHandoffRejectedMessage({
      protocol: REPAIR_READER_HANDOFF_PROTOCOL,
      type: "rejected",
      ...SESSION,
      code: "archive-validation-failed"
    }, SESSION)).toBe(true);
    expect(isHandoffRejectedMessage({
      protocol: REPAIR_READER_HANDOFF_PROTOCOL,
      type: "rejected",
      ...SESSION,
      code: "raw-exception"
    }, SESSION)).toBe(false);
  });

  it("opens only on demand, ignores unrelated messages, transfers one copy, and preserves the Repair bytes", async () => {
    const source = new Uint8Array(22);
    source.set([0x50, 0x4b, 0x05, 0x06]);
    const expected = source.slice();
    let openedPath = "";
    let packagePosts = 0;
    let received: VerifiedPackageMessage | undefined;
    let harness: ReturnType<typeof senderHarness>;
    const child: ReaderPreviewMessagePeer = {
      postMessage(message, targetOrigin, transfer = []) {
        expect(targetOrigin).toBe(ORIGIN);
        packagePosts += 1;
        received = structuredClone(message, { transfer }) as VerifiedPackageMessage;
        queueMicrotask(() => harness.dispatch({ origin: ORIGIN, source: child, data: acceptedMessage() }));
      }
    };
    harness = senderHarness((path) => {
      openedPath = path;
      queueMicrotask(() => {
        harness.dispatch({ origin: "https://evil.example", source: child, data: readyMessage() });
        harness.dispatch({ origin: ORIGIN, source: {}, data: readyMessage() });
        harness.dispatch({ origin: ORIGIN, source: child, data: { ...readyMessage() as object, extra: true } });
        harness.dispatch({ origin: ORIGIN, source: child, data: readyMessage() });
        harness.dispatch({ origin: ORIGIN, source: child, data: readyMessage() });
      });
      return child;
    });

    await expect(sendVerifiedPackageToReader({
      name: "paper.after-mineru.zip",
      bytes: source.buffer,
      fileCount: 1
    }, { environment: harness.environment })).resolves.toEqual({ status: "accepted" });

    expect(openedPath).toBe(`/reader${FRAGMENT}`);
    expect(packagePosts).toBe(1);
    expect(received?.archive.bytes).not.toBe(source.buffer);
    expect(received?.archive.bytes.byteLength).toBe(22);
    expect(source.buffer.byteLength).toBe(22);
    expect(source).toEqual(expected);
    expect(harness.listeners.size).toBe(0);
    expect(harness.timers.callbacks.size).toBe(0);
  });

  it("fails without copying when the popup is blocked, and cleans up on cancellation", async () => {
    const source = new ArrayBuffer(22);
    const blocked = senderHarness(() => null);
    await expect(sendVerifiedPackageToReader({
      name: "paper.after-mineru.zip",
      bytes: source,
      fileCount: 1
    }, { environment: blocked.environment })).rejects.toMatchObject({ code: "popup-blocked" });
    expect(source.byteLength).toBe(22);
    expect(blocked.listeners.size).toBe(0);
    expect(blocked.timers.callbacks.size).toBe(0);

    const oversized = new ArrayBuffer(22);
    Object.defineProperty(oversized, "byteLength", {
      value: REPAIR_READER_HANDOFF_LIMITS.archiveBytes + 1
    });
    const openReader = vi.fn<ReaderPreviewSenderEnvironment["openReader"]>();
    const limited = senderHarness(openReader);
    await expect(sendVerifiedPackageToReader({
      name: "paper.after-mineru.zip",
      bytes: oversized,
      fileCount: 1
    }, { environment: limited.environment })).rejects.toMatchObject({ code: "preview-size-limit-exceeded" });
    expect(openReader).not.toHaveBeenCalled();

    const child: ReaderPreviewMessagePeer = { postMessage: vi.fn() };
    const pending = senderHarness(() => child);
    const controller = new AbortController();
    const promise = sendVerifiedPackageToReader({
      name: "paper.after-mineru.zip",
      bytes: source,
      fileCount: 1
    }, { environment: pending.environment, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(pending.listeners.size).toBe(0);
    expect(pending.timers.callbacks.size).toBe(0);
  });

  it("receives once from the exact opener, validates before accepting, and detaches the opener", async () => {
    const posted: unknown[] = [];
    let validationCalls = 0;
    let harness: ReturnType<typeof receiverHarness>;
    harness = receiverHarness({
      onPost(message, targetOrigin) {
        expect(targetOrigin).toBe(ORIGIN);
        posted.push(message);
        if (isReaderReadyMessage(message, SESSION)) {
          queueMicrotask(() => {
            harness.dispatch({ origin: "https://evil.example", source: harness.opener, data: archiveMessage() });
            harness.dispatch({ origin: ORIGIN, source: {}, data: archiveMessage() });
            harness.dispatch({ origin: ORIGIN, source: harness.opener, data: archiveMessage() });
            harness.dispatch({ origin: ORIGIN, source: harness.opener, data: archiveMessage() });
          });
        }
      }
    });

    const result = await receiveVerifiedPackagePreview({
      environment: harness.environment,
      async validateArchive(archive) {
        validationCalls += 1;
        expect(archive.name).toBe("paper.after-mineru.zip");
        return { verified: true };
      }
    });

    expect(result).toEqual({
      status: "accepted",
      archiveName: "paper.after-mineru.zip",
      value: { verified: true }
    });
    expect(validationCalls).toBe(1);
    expect(posted.some((message) => isHandoffAcceptedMessage(message, SESSION))).toBe(true);
    expect(harness.replaced).toEqual(["/reader"]);
    expect(harness.detached).toBe(true);
    expect(harness.listeners.size).toBe(0);
    expect(harness.timers.callbacks.size).toBe(0);
  });

  it("fails closed before validation for a matching malformed payload", async () => {
    const posted: unknown[] = [];
    let harness: ReturnType<typeof receiverHarness>;
    harness = receiverHarness({
      onPost(message) {
        posted.push(message);
        if (isReaderReadyMessage(message, SESSION)) {
          queueMicrotask(() => harness.dispatch({
            origin: ORIGIN,
            source: harness.opener,
            data: { ...archiveMessage(), unexpected: true }
          }));
        }
      }
    });
    const validateArchive = vi.fn();

    await expect(receiveVerifiedPackagePreview({
      environment: harness.environment,
      validateArchive
    })).rejects.toMatchObject({ code: "invalid-payload" });
    expect(validateArchive).not.toHaveBeenCalled();
    expect(posted.some((message) => isHandoffRejectedMessage(message, SESSION))).toBe(true);
    expect(harness.detached).toBe(true);
  });

  it("expires validation, disposes a late result, and never acknowledges it", async () => {
    const posted: unknown[] = [];
    let finishValidation: ((value: { dispose: () => void }) => void) | undefined;
    let harness: ReturnType<typeof receiverHarness>;
    harness = receiverHarness({
      onPost(message) {
        posted.push(message);
        if (isReaderReadyMessage(message, SESSION)) {
          queueMicrotask(() => harness.dispatch({ origin: ORIGIN, source: harness.opener, data: archiveMessage() }));
        }
      }
    });
    const disposed = vi.fn();
    const promise = receiveVerifiedPackagePreview({
      environment: harness.environment,
      validationMs: 1,
      validateArchive: () => new Promise<{ dispose: () => void }>((resolve) => { finishValidation = resolve; }),
      disposeValidated: (value) => value.dispose()
    });
    await vi.waitFor(() => expect(finishValidation).toBeTypeOf("function"));
    harness.advance(2);
    harness.timers.fireAll();
    await expect(promise).rejects.toMatchObject({ code: "expired" });
    finishValidation!({ dispose: disposed });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledOnce();
    expect(posted.some((message) => isHandoffAcceptedMessage(message, SESSION))).toBe(false);
    expect(posted.some((message) => (
      isHandoffRejectedMessage(message, SESSION) && message.code === "expired"
    ))).toBe(true);
  });

  it("keeps the handoff memory-only and preserves the Reader read-only switches", () => {
    const protocolSource = readFileSync("sites-reader/lib/repair-reader-preview.ts", "utf8");
    const repairSource = readFileSync("sites-reader/app/repair/page.tsx", "utf8");
    const readerSource = readFileSync("sites-reader/app/reader/page.tsx", "utf8");
    expect(protocolSource).not.toMatch(/localStorage|sessionStorage|indexedDB|BroadcastChannel|fetch\s*\(/);
    expect(protocolSource).not.toContain('postMessage(message, "*")');
    expect(repairSource).toContain("在 Reader 中预览（新标签页）");
    expect(readerSource).toContain("allowPdfProjection: false");
    expect(readerSource).toContain("allowRuntimeTextRecovery: false");
    expect(readerSource).toContain("persistPaperState: false");
    expect(REPAIR_READER_HANDOFF_LIMITS.archiveBytes).toBe(32 * 1024 * 1024);
  });

  it("mounts every Sites Reader surface with strict read-only capabilities", () => {
    const readerMountFiles = readdirSync("sites-reader/app", { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".tsx"))
      .map((path) => `sites-reader/app/${path.replace(/\\/g, "/")}`)
      .filter((path) => readFileSync(path, "utf8").includes("mountLocalReader"))
      .sort();

    expect(readerMountFiles).toEqual(expect.arrayContaining([
      "sites-reader/app/demo/debyecalculator/page.tsx",
      "sites-reader/app/page.tsx",
      "sites-reader/app/reader/page.tsx"
    ]));
    expect(readerMountFiles.length).toBeGreaterThan(0);
    readerMountFiles.forEach((path) => {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must use the strict Reader profile`)
        .toContain('capabilityProfile: "strict-readonly"');
    });
    const demoSource = readFileSync("sites-reader/app/demo/debyecalculator/page.tsx", "utf8");
    expect(demoSource).toContain("mountLocalReaderWithReady");
    expect(demoSource).toContain("createReaderFileSystem");
    expect(demoSource).toContain("createRawPreviewFileSystem");
    expect(demoSource).not.toContain('capabilityProfile: "legacy-v0.1.3"');
  });

  it("returns an untouched normal Reader path when no preview fragment exists", async () => {
    const harness = receiverHarness({ hash: "#paper-section" });
    const result = await receiveVerifiedPackagePreview({
      environment: harness.environment,
      validateArchive: vi.fn()
    });
    expect(result).toEqual({ status: "absent" });
    expect(harness.replaced).toEqual([]);
    expect(harness.detached).toBe(false);
    expect(harness.listeners.size).toBe(0);
  });

  it("clears and detaches an invalid preview fragment before falling back", async () => {
    const harness = receiverHarness({ hash: "#repair-preview=v1.invalid" });
    await expect(receiveVerifiedPackagePreview({
      environment: harness.environment,
      validateArchive: vi.fn()
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(harness.replaced).toEqual(["/reader"]);
    expect(harness.detached).toBe(true);
    expect(harness.listeners.size).toBe(0);
  });
});
