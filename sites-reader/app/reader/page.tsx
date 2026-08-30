"use client";

import { useEffect, useRef, useState } from "react";
import {
  ReaderPreviewHandoffError,
  receiveVerifiedPackagePreview
} from "../../lib/repair-reader-preview";

type ReaderPreviewStatus = {
  tone: "working" | "ready" | "error";
  message: string;
};

type MountedReaderPreview = {
  archiveName: string;
  dispose(): void;
};

type ReaderPreviewSession = {
  controller: AbortController;
  promise: Promise<MountedReaderPreview>;
  activeToken?: symbol;
  cleanupTimer?: number;
  result?: MountedReaderPreview;
};

const READ_ONLY_READER_OPTIONS = Object.freeze({
  capabilityProfile: "strict-readonly" as const,
  allowPdfProjection: false,
  allowDirectPdfOpen: true,
  allowRuntimeTextRecovery: false,
  enableWebMcp: false,
  enableProcessingApi: false,
  persistPaperState: false
});

function cancelledPreviewError(): ReaderPreviewHandoffError {
  return new ReaderPreviewHandoffError("cancelled", "Reader 预览交接已取消。");
}

function once(dispose: () => void): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
}

export default function ReaderPage() {
  const root = useRef<HTMLDivElement>(null);
  const previewSession = useRef<ReaderPreviewSession | null>(null);
  const [failed, setFailed] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<ReaderPreviewStatus | null>(null);

  useEffect(() => {
    if (!root.current) return;
    const token = Symbol("reader-preview-effect");
    let cancelled = false;
    let disposeNormalReader: (() => void) | undefined;

    const mountNormalReader = async () => {
      try {
        const { mountLocalReader } = await import("../../../local-reader/main");
        if (cancelled || !root.current) return;
        disposeNormalReader = mountLocalReader(root.current, READ_ONLY_READER_OPTIONS);
      } catch (error) {
        console.error("Paper2MD Reader failed to start", error);
        if (!cancelled) {
          setPreviewStatus(null);
          setFailed(true);
        }
      }
    };

    const createPreviewSession = (): ReaderPreviewSession => {
      const controller = new AbortController();
      const readerModule = import("../../../local-reader/main");
      let session: ReaderPreviewSession;
      const promise = receiveVerifiedPackagePreview({
        signal: controller.signal,
        validateArchive: async (archive, validationSignal) => {
          if (!session.activeToken || !root.current) throw cancelledPreviewError();
          setPreviewStatus({ tone: "working", message: "已接收一次性内存包，正在专用 Worker 中复验并加载只读 Reader…" });
          const [{ importAfterMinerUPreviewWithWorker }, { mountLocalReaderWithReady }] = await Promise.all([
            import("../../../apps/web/src/after-mineru-preview-worker-client"),
            readerModule
          ]);
          if (validationSignal.aborted || !session.activeToken || !root.current) {
            throw cancelledPreviewError();
          }
          const fileSystem = await importAfterMinerUPreviewWithWorker(archive.bytes, archive.name, {
            expectedFileCount: archive.fileCount,
            signal: validationSignal
          });
          if (validationSignal.aborted || !session.activeToken || !root.current) {
            fileSystem.dispose();
            throw cancelledPreviewError();
          }
          let mounted: ReturnType<typeof mountLocalReaderWithReady>;
          try {
            mounted = mountLocalReaderWithReady(root.current, {
              ...READ_ONLY_READER_OPTIONS,
              initialFileSystem: fileSystem
            });
          } catch (error) {
            fileSystem.dispose();
            throw error;
          }
          const disposeMounted = once(() => mounted.dispose());
          const disposeOnAbort = () => disposeMounted();
          validationSignal.addEventListener("abort", disposeOnAbort, { once: true });
          try {
            await mounted.ready;
            if (validationSignal.aborted || !session.activeToken) {
              disposeMounted();
              throw cancelledPreviewError();
            }
            return { dispose: disposeMounted };
          } catch (error) {
            disposeMounted();
            throw error;
          } finally {
            validationSignal.removeEventListener("abort", disposeOnAbort);
          }
        },
        disposeValidated(value) {
          value.dispose();
        }
      }).then((preview): MountedReaderPreview => {
        if (preview.status !== "accepted") throw new Error("Reader preview request unexpectedly disappeared.");
        return { archiveName: preview.archiveName, dispose: preview.value.dispose };
      });
      session = { controller, promise, activeToken: token };
      void promise.then((result) => {
        session.result = result;
        if (!session.activeToken) {
          result.dispose();
          session.result = undefined;
        }
      }, () => undefined);
      return session;
    };

    const hasPreviewRequest = Boolean(previewSession.current)
      || window.location.hash.startsWith("#repair-preview=");
    if (!hasPreviewRequest) {
      void mountNormalReader();
    } else {
      const session = previewSession.current ?? createPreviewSession();
      previewSession.current = session;
      if (session.cleanupTimer !== undefined) {
        window.clearTimeout(session.cleanupTimer);
        session.cleanupTimer = undefined;
      }
      session.activeToken = token;
      setPreviewStatus({ tone: "working", message: "正在等待 After-MinerU Repair 的一次性内存交接…" });
      void session.promise.then((result) => {
        if (cancelled || session.activeToken !== token) return;
        setPreviewStatus({
          tone: "ready",
          message: `${result.archiveName} 已验证并加载到只读 Reader；仅保留在此标签页内存中，刷新或关闭后需重新打开。`
        });
      }).catch((error: unknown) => {
        if (cancelled || session.activeToken !== token) return;
        console.warn("Paper2MD Reader preview handoff failed closed", error);
        setPreviewStatus({
          tone: "error",
          message: error instanceof ReaderPreviewHandoffError
            ? error.message
            : "预览包未能通过本地复验与只读加载；已回退到普通 Reader，可手动选择验证包。"
        });
        void mountNormalReader();
      });
    }

    return () => {
      cancelled = true;
      disposeNormalReader?.();
      const session = previewSession.current;
      if (!session || session.activeToken !== token) return;
      session.activeToken = undefined;
      session.cleanupTimer = window.setTimeout(() => {
        session.cleanupTimer = undefined;
        if (session.activeToken) return;
        session.controller.abort();
        session.result?.dispose();
        session.result = undefined;
        if (previewSession.current === session) previewSession.current = null;
      }, 0);
    };
  }, []);

  return (
    <main className="site-reader-shell" data-reader-mode="read-only">
      <div className="site-reader-bar">
        <a className="reader-home-link" href="/">← After‑MinerU</a>
        <span>Paper2MD Reader · 只读本地会话</span>
        <div className="reader-bar-actions"><a href="/repair">修复 MinerU 结果</a><a href="/demo/debyecalculator">真实示例</a></div>
      </div>
      {previewStatus ? <div className={`site-reader-status ${previewStatus.tone}`} role={previewStatus.tone === "error" ? "alert" : "status"}>{previewStatus.message}</div> : null}
      {failed ? (
        <section className="p2md-site-startup-error" role="alert">
          <h1>阅读器未能启动</h1>
          <p>请刷新页面后重试；你的本地文件不会上传到 Paper2MD，也不会写入浏览器持久存储。</p>
          <a className="site-primary reader-error-link" href="/">返回首页</a>
        </section>
      ) : (
        <div ref={root} className={`site-reader-root${previewStatus ? " has-status" : ""}`} aria-label="Paper2MD 只读 Reader" />
      )}
    </main>
  );
}
