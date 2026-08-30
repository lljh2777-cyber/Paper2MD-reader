export const REPAIR_READER_HANDOFF_PROTOCOL = "after-mineru-repair-reader-handoff-v1" as const;

export const REPAIR_READER_HANDOFF_LIMITS = Object.freeze({
  handshakeMs: 30_000,
  validationMs: 60_000,
  archiveBytes: 32 * 1024 * 1024,
  archiveFileCount: 2_048,
  minimumZipBytes: 22
});

const HANDOFF_READER_PATH_PREFIX = "/reader#repair-preview=v1.";
const VERIFIED_ARCHIVE_NAME_RE = /^[A-Za-z0-9._-]+\.after-mineru\.zip$/i;

type UnknownRecord = Record<string, unknown>;

export type RepairReaderHandoffRejectionCode =
  | "invalid-payload"
  | "preview-size-limit-exceeded"
  | "archive-validation-failed"
  | "expired";

export type ReaderPreviewHandoffErrorCode =
  | RepairReaderHandoffRejectionCode
  | "cancelled"
  | "invalid-request"
  | "missing-opener"
  | "popup-blocked"
  | "rejected"
  | "transport-failed";

interface HandoffEnvelope {
  protocol: typeof REPAIR_READER_HANDOFF_PROTOCOL;
  handoffId: string;
  nonce: string;
}

export interface ReaderReadyMessage extends HandoffEnvelope {
  type: "reader-ready";
}

export interface VerifiedPackageArchive {
  kind: "after-mineru-verified-package";
  name: string;
  byteLength: number;
  fileCount: number;
  bytes: ArrayBuffer;
}

export interface VerifiedPackageMessage extends HandoffEnvelope {
  type: "verified-package";
  archive: VerifiedPackageArchive;
}

export interface HandoffAcceptedMessage extends HandoffEnvelope {
  type: "accepted";
}

export interface HandoffRejectedMessage extends HandoffEnvelope {
  type: "rejected";
  code: RepairReaderHandoffRejectionCode;
}

export type RepairReaderHandoffMessage =
  | ReaderReadyMessage
  | VerifiedPackageMessage
  | HandoffAcceptedMessage
  | HandoffRejectedMessage;

export interface ReaderPreviewArchiveInput {
  name: string;
  bytes: ArrayBuffer;
  fileCount: number;
}

export type ReaderPreviewFragment =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; handoffId: string; nonce: string };

export interface ReaderPreviewMessagePeer {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export interface ReaderPreviewMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

export type ReaderPreviewMessageListener = (event: ReaderPreviewMessageEvent) => void;

export interface ReaderPreviewSenderEnvironment {
  origin: string;
  openReader(path: string): ReaderPreviewMessagePeer | null;
  addMessageListener(listener: ReaderPreviewMessageListener): void;
  removeMessageListener(listener: ReaderPreviewMessageListener): void;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(timer: number): void;
  randomBytes(length: number): Uint8Array;
  now(): number;
}

export interface ReaderPreviewReceiverEnvironment {
  origin: string;
  hash: string;
  pathAndQuery: string;
  opener: ReaderPreviewMessagePeer | null;
  addMessageListener(listener: ReaderPreviewMessageListener): void;
  removeMessageListener(listener: ReaderPreviewMessageListener): void;
  replaceUrl(pathAndQuery: string): void;
  detachOpener(): void;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(timer: number): void;
  now(): number;
}

export interface SendReaderPreviewOptions {
  signal?: AbortSignal;
  environment?: ReaderPreviewSenderEnvironment;
  handshakeMs?: number;
  validationMs?: number;
}

export interface ReceiveReaderPreviewOptions<T> {
  signal?: AbortSignal;
  environment?: ReaderPreviewReceiverEnvironment;
  handshakeMs?: number;
  validationMs?: number;
  validateArchive(archive: VerifiedPackageArchive, signal: AbortSignal): Promise<T>;
  disposeValidated?(value: T): void;
}

export type ReceiveReaderPreviewResult<T> =
  | { status: "absent" }
  | { status: "accepted"; archiveName: string; value: T };

export class ReaderPreviewHandoffError extends Error {
  readonly code: ReaderPreviewHandoffErrorCode;

  constructor(code: ReaderPreviewHandoffErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReaderPreviewHandoffError";
    this.code = code;
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function matchesSession(value: unknown, session: { handoffId: string; nonce: string }): boolean {
  const message = record(value);
  return message?.protocol === REPAIR_READER_HANDOFF_PROTOCOL
    && message.handoffId === session.handoffId
    && message.nonce === session.nonce;
}

function validArchiveName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > ".after-mineru.zip".length
    && value.length <= 255
    && value === value.trim()
    && VERIFIED_ARCHIVE_NAME_RE.test(value);
}

function validFileCount(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) > 0
    && Number(value) <= REPAIR_READER_HANDOFF_LIMITS.archiveFileCount;
}

function archiveRejectionCode(value: unknown): RepairReaderHandoffRejectionCode | undefined {
  const archive = record(value);
  if (!archive || !exactKeys(archive, ["kind", "name", "byteLength", "fileCount", "bytes"])) {
    return "invalid-payload";
  }
  if (archive.kind !== "after-mineru-verified-package"
    || !validArchiveName(archive.name)
    || !validFileCount(archive.fileCount)
    || !(archive.bytes instanceof ArrayBuffer)
    || !Number.isSafeInteger(archive.byteLength)
    || archive.byteLength !== archive.bytes.byteLength
    || archive.byteLength < REPAIR_READER_HANDOFF_LIMITS.minimumZipBytes) {
    return "invalid-payload";
  }
  if (archive.byteLength > REPAIR_READER_HANDOFF_LIMITS.archiveBytes) {
    return "preview-size-limit-exceeded";
  }
  return undefined;
}

function asVerifiedArchive(value: unknown): VerifiedPackageArchive | undefined {
  return archiveRejectionCode(value) ? undefined : value as VerifiedPackageArchive;
}

export function parseReaderPreviewFragment(hash: string): ReaderPreviewFragment {
  if (!hash.startsWith("#repair-preview=")) return { status: "absent" };
  const match = /^#repair-preview=v1\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(hash);
  return match
    ? { status: "valid", handoffId: match[1]!, nonce: match[2]! }
    : { status: "invalid" };
}

export function isReaderReadyMessage(
  value: unknown,
  session: { handoffId: string; nonce: string }
): value is ReaderReadyMessage {
  const message = record(value);
  return Boolean(message)
    && exactKeys(message!, ["protocol", "type", "handoffId", "nonce"])
    && matchesSession(message, session)
    && message!.type === "reader-ready";
}

export function isVerifiedPackageMessage(
  value: unknown,
  session: { handoffId: string; nonce: string }
): value is VerifiedPackageMessage {
  const message = record(value);
  return Boolean(message)
    && exactKeys(message!, ["protocol", "type", "handoffId", "nonce", "archive"])
    && matchesSession(message, session)
    && message!.type === "verified-package"
    && Boolean(asVerifiedArchive(message!.archive));
}

export function isHandoffAcceptedMessage(
  value: unknown,
  session: { handoffId: string; nonce: string }
): value is HandoffAcceptedMessage {
  const message = record(value);
  return Boolean(message)
    && exactKeys(message!, ["protocol", "type", "handoffId", "nonce"])
    && matchesSession(message, session)
    && message!.type === "accepted";
}

export function isHandoffRejectedMessage(
  value: unknown,
  session: { handoffId: string; nonce: string }
): value is HandoffRejectedMessage {
  const message = record(value);
  return Boolean(message)
    && exactKeys(message!, ["protocol", "type", "handoffId", "nonce", "code"])
    && matchesSession(message, session)
    && message!.type === "rejected"
    && (message!.code === "invalid-payload"
      || message!.code === "preview-size-limit-exceeded"
      || message!.code === "archive-validation-failed"
      || message!.code === "expired");
}

function handoffError(code: ReaderPreviewHandoffErrorCode, cause?: unknown): ReaderPreviewHandoffError {
  const messages: Record<ReaderPreviewHandoffErrorCode, string> = {
    "invalid-payload": "Reader 预览交接数据无效；请下载验证包后手动打开。",
    "preview-size-limit-exceeded": "验证包超过 32 MiB 在线预览限制；请下载后在 Reader 中手动打开。",
    "archive-validation-failed": "验证包未通过 Reader 的 manifest、路径或哈希复验，未加载任何内容。",
    expired: "Reader 预览交接已超时；验证包仍可下载后手动打开。",
    cancelled: "Reader 预览交接已取消。",
    "invalid-request": "Reader 预览链接无效或已失效；已回退到普通只读 Reader。",
    "missing-opener": "当前标签页没有可验证的 Repair 来源；已回退到普通只读 Reader。",
    "popup-blocked": "浏览器阻止了 Reader 新标签页；请允许弹窗或下载验证包后手动打开。",
    rejected: "Reader 拒绝了本次预览交接；请下载验证包后手动打开。",
    "transport-failed": "浏览器未能完成同源内存交接；验证包仍可下载后手动打开。"
  };
  return new ReaderPreviewHandoffError(code, messages[code], cause === undefined ? undefined : { cause });
}

function randomHex(environment: ReaderPreviewSenderEnvironment, byteLength: number): string {
  const bytes = environment.randomBytes(byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    throw handoffError("transport-failed");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function senderEnvironmentFromWindow(browser: Window): ReaderPreviewSenderEnvironment {
  return {
    origin: browser.location.origin,
    openReader(path) {
      return browser.open(path, "_blank") as ReaderPreviewMessagePeer | null;
    },
    addMessageListener(listener) {
      browser.addEventListener("message", listener as (event: MessageEvent) => void);
    },
    removeMessageListener(listener) {
      browser.removeEventListener("message", listener as (event: MessageEvent) => void);
    },
    setTimer(callback, milliseconds) {
      return browser.setTimeout(callback, milliseconds);
    },
    clearTimer(timer) {
      browser.clearTimeout(timer);
    },
    randomBytes(length) {
      return browser.crypto.getRandomValues(new Uint8Array(length));
    },
    now() {
      return browser.performance.now();
    }
  };
}

function receiverEnvironmentFromWindow(browser: Window): ReaderPreviewReceiverEnvironment {
  return {
    origin: browser.location.origin,
    hash: browser.location.hash,
    pathAndQuery: `${browser.location.pathname}${browser.location.search}`,
    opener: browser.opener as ReaderPreviewMessagePeer | null,
    addMessageListener(listener) {
      browser.addEventListener("message", listener as (event: MessageEvent) => void);
    },
    removeMessageListener(listener) {
      browser.removeEventListener("message", listener as (event: MessageEvent) => void);
    },
    replaceUrl(pathAndQuery) {
      browser.history.replaceState(browser.history.state, "", pathAndQuery);
    },
    detachOpener() {
      browser.opener = null;
    },
    setTimer(callback, milliseconds) {
      return browser.setTimeout(callback, milliseconds);
    },
    clearTimer(timer) {
      browser.clearTimeout(timer);
    },
    now() {
      return browser.performance.now();
    }
  };
}

function defaultSenderEnvironment(): ReaderPreviewSenderEnvironment {
  if (typeof window === "undefined") throw handoffError("transport-failed");
  return senderEnvironmentFromWindow(window);
}

function defaultReceiverEnvironment(): ReaderPreviewReceiverEnvironment {
  if (typeof window === "undefined") throw handoffError("transport-failed");
  return receiverEnvironmentFromWindow(window);
}

function assertSendArchive(input: ReaderPreviewArchiveInput): void {
  if (!input || typeof input !== "object" || !(input.bytes instanceof ArrayBuffer)) {
    throw handoffError("invalid-payload");
  }
  const rejection = archiveRejectionCode({
    kind: "after-mineru-verified-package",
    name: input.name,
    byteLength: input.bytes.byteLength,
    fileCount: input.fileCount,
    bytes: input.bytes
  });
  if (rejection) throw handoffError(rejection);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function sendVerifiedPackageToReader(
  input: ReaderPreviewArchiveInput,
  options: SendReaderPreviewOptions = {}
): Promise<{ status: "accepted" }> {
  return new Promise((resolve, reject) => {
    let environment: ReaderPreviewSenderEnvironment;
    try {
      environment = options.environment ?? defaultSenderEnvironment();
      assertSendArchive(input);
      if (options.signal?.aborted) throw handoffError("cancelled");
    } catch (error) {
      reject(error);
      return;
    }

    let handoffId: string;
    let nonce: string;
    try {
      handoffId = randomHex(environment, 16);
      nonce = randomHex(environment, 32);
    } catch (error) {
      reject(error);
      return;
    }
    const session = { handoffId, nonce };
    let child: ReaderPreviewMessagePeer | null;
    try {
      child = environment.openReader(`${HANDOFF_READER_PATH_PREFIX}${handoffId}.${nonce}`);
    } catch (error) {
      reject(handoffError("transport-failed", error));
      return;
    }
    if (!child) {
      reject(handoffError("popup-blocked"));
      return;
    }

    const handshakeMs = positiveTimeout(options.handshakeMs, REPAIR_READER_HANDOFF_LIMITS.handshakeMs);
    const validationMs = positiveTimeout(options.validationMs, REPAIR_READER_HANDOFF_LIMITS.validationMs);
    let state: "waiting-ready" | "payload-sent" | "settled" = "waiting-ready";
    let deadline = environment.now() + handshakeMs;
    let timer: number | undefined;

    const cleanup = () => {
      environment.removeMessageListener(onMessage);
      if (timer !== undefined) environment.clearTimer(timer);
      options.signal?.removeEventListener("abort", onAbort);
      timer = undefined;
    };
    const fail = (error: ReaderPreviewHandoffError) => {
      if (state === "settled") return;
      state = "settled";
      cleanup();
      reject(error);
    };
    const expire = () => fail(handoffError("expired"));
    const onAbort = () => fail(handoffError("cancelled"));
    const onMessage = (event: ReaderPreviewMessageEvent) => {
      if (state === "settled" || event.origin !== environment.origin || event.source !== child) return;
      if (state === "waiting-ready") {
        if (!isReaderReadyMessage(event.data, session)) return;
        if (environment.now() > deadline) {
          expire();
          return;
        }
        try {
          const bytes = input.bytes.slice(0);
          const message: VerifiedPackageMessage = {
            protocol: REPAIR_READER_HANDOFF_PROTOCOL,
            type: "verified-package",
            handoffId,
            nonce,
            archive: {
              kind: "after-mineru-verified-package",
              name: input.name,
              byteLength: bytes.byteLength,
              fileCount: input.fileCount,
              bytes
            }
          };
          state = "payload-sent";
          if (timer !== undefined) environment.clearTimer(timer);
          deadline = environment.now() + validationMs;
          timer = environment.setTimer(expire, validationMs);
          child.postMessage(message, environment.origin, [bytes]);
        } catch (error) {
          fail(handoffError("transport-failed", error));
          return;
        }
        return;
      }
      if (environment.now() > deadline) {
        expire();
        return;
      }
      if (isHandoffAcceptedMessage(event.data, session)) {
        state = "settled";
        cleanup();
        resolve({ status: "accepted" });
      } else if (isHandoffRejectedMessage(event.data, session)) {
        fail(handoffError(event.data.code));
      }
    };

    environment.addMessageListener(onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = environment.setTimer(expire, handshakeMs);
  });
}

function postToOpener(
  opener: ReaderPreviewMessagePeer,
  origin: string,
  message: HandoffAcceptedMessage | HandoffRejectedMessage
): void {
  try {
    opener.postMessage(message, origin);
  } catch {
    // The Reader can still fail closed or display a fully validated package if the opener has gone away.
  }
}

function disposeValue<T>(value: T, dispose: ((value: T) => void) | undefined): void {
  try {
    dispose?.(value);
  } catch {
    // Cleanup is best-effort and must not replace the original timeout/cancellation result.
  }
}

function validateBeforeDeadline<T>(
  archive: VerifiedPackageArchive,
  options: ReceiveReaderPreviewOptions<T>,
  environment: ReaderPreviewReceiverEnvironment
): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(handoffError("cancelled"));
  const validationMs = positiveTimeout(options.validationMs, REPAIR_READER_HANDOFF_LIMITS.validationMs);
  const deadline = environment.now() + validationMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const validationController = new AbortController();
    const cleanup = () => {
      environment.clearTimer(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: ReaderPreviewHandoffError) => {
      if (settled) return;
      settled = true;
      validationController.abort();
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(handoffError("cancelled"));
    const timer = environment.setTimer(() => fail(handoffError("expired")), validationMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    void Promise.resolve()
      .then(() => options.validateArchive(archive, validationController.signal))
      .then((value) => {
        if (settled) {
          disposeValue(value, options.disposeValidated);
          return;
        }
        if (options.signal?.aborted || environment.now() > deadline) {
          settled = true;
          validationController.abort();
          cleanup();
          disposeValue(value, options.disposeValidated);
          reject(handoffError(options.signal?.aborted ? "cancelled" : "expired"));
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      }, (error: unknown) => {
        if (!settled) {
          fail(error instanceof ReaderPreviewHandoffError && error.code === "cancelled"
            ? error
            : handoffError("archive-validation-failed", error));
        }
      });
  });
}

export async function receiveVerifiedPackagePreview<T>(
  options: ReceiveReaderPreviewOptions<T>
): Promise<ReceiveReaderPreviewResult<T>> {
  const environment = options.environment ?? defaultReceiverEnvironment();
  const fragment = parseReaderPreviewFragment(environment.hash);
  if (fragment.status === "absent") return { status: "absent" };
  environment.replaceUrl(environment.pathAndQuery);
  if (fragment.status === "invalid") {
    environment.detachOpener();
    throw handoffError("invalid-request");
  }
  if (options.signal?.aborted) {
    environment.detachOpener();
    throw handoffError("cancelled");
  }

  const opener = environment.opener;
  if (!opener) {
    environment.detachOpener();
    throw handoffError("missing-opener");
  }
  const session = { handoffId: fragment.handoffId, nonce: fragment.nonce };
  const handshakeMs = positiveTimeout(options.handshakeMs, REPAIR_READER_HANDOFF_LIMITS.handshakeMs);
  const handshakeDeadline = environment.now() + handshakeMs;

  let archive: VerifiedPackageArchive;
  try {
    archive = await new Promise<VerifiedPackageArchive>((resolve, reject) => {
      let settled = false;
      let timer: number | undefined;
      const cleanup = () => {
        environment.removeMessageListener(onMessage);
        if (timer !== undefined) environment.clearTimer(timer);
        options.signal?.removeEventListener("abort", onAbort);
        timer = undefined;
      };
      const fail = (error: ReaderPreviewHandoffError, code: RepairReaderHandoffRejectionCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        postToOpener(opener, environment.origin, {
          protocol: REPAIR_READER_HANDOFF_PROTOCOL,
          type: "rejected",
          handoffId: fragment.handoffId,
          nonce: fragment.nonce,
          code
        });
        reject(error);
      };
      const onAbort = () => fail(handoffError("cancelled"), "expired");
      const onMessage = (event: ReaderPreviewMessageEvent) => {
        if (settled || event.origin !== environment.origin || event.source !== opener) return;
        if (!matchesSession(event.data, session)) return;
        if (environment.now() > handshakeDeadline) {
          fail(handoffError("expired"), "expired");
          return;
        }
        const message = record(event.data);
        const rejection = message?.type === "verified-package"
          ? archiveRejectionCode(message.archive)
          : "invalid-payload";
        if (!isVerifiedPackageMessage(event.data, session) || rejection) {
          fail(handoffError(rejection ?? "invalid-payload"), rejection ?? "invalid-payload");
          return;
        }
        settled = true;
        cleanup();
        resolve(event.data.archive);
      };

      environment.addMessageListener(onMessage);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = environment.setTimer(() => fail(handoffError("expired"), "expired"), handshakeMs);
      const ready: ReaderReadyMessage = {
        protocol: REPAIR_READER_HANDOFF_PROTOCOL,
        type: "reader-ready",
        handoffId: fragment.handoffId,
        nonce: fragment.nonce
      };
      try {
        opener.postMessage(ready, environment.origin);
      } catch (error) {
        fail(handoffError("transport-failed", error), "expired");
      }
    });
  } catch (error) {
    environment.detachOpener();
    throw error;
  }

  environment.detachOpener();
  try {
    const value = await validateBeforeDeadline(archive, options, environment);
    postToOpener(opener, environment.origin, {
      protocol: REPAIR_READER_HANDOFF_PROTOCOL,
      type: "accepted",
      handoffId: fragment.handoffId,
      nonce: fragment.nonce
    });
    return { status: "accepted", archiveName: archive.name, value };
  } catch (error) {
    const code = error instanceof ReaderPreviewHandoffError && (error.code === "expired" || error.code === "cancelled")
      ? "expired"
      : "archive-validation-failed";
    postToOpener(opener, environment.origin, {
      protocol: REPAIR_READER_HANDOFF_PROTOCOL,
      type: "rejected",
      handoffId: fragment.handoffId,
      nonce: fragment.nonce,
      code
    });
    throw error;
  }
}
