"use client";

import { useEffect, useRef, useState } from "react";

export default function ReaderPage() {
  const root = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!root.current) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../../../local-reader/main")
      .then(({ mountLocalReader }) => {
        if (cancelled || !root.current) return;
        dispose = mountLocalReader(root.current, {
          allowPdfProjection: false,
          allowDirectPdfOpen: true,
          allowRuntimeTextRecovery: false,
          enableWebMcp: false,
          enableProcessingApi: false,
          persistPaperState: false
        });
      })
      .catch((error: unknown) => {
        console.error("Paper2MD Reader failed to start", error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return (
    <main className="site-reader-shell" data-reader-mode="read-only">
      <div className="site-reader-bar">
        <a className="reader-home-link" href="/">← After‑MinerU</a>
        <span>Paper2MD Reader · 只读本地会话</span>
        <div className="reader-bar-actions"><a href="/repair">修复 MinerU 结果</a><a href="/demo/debyecalculator">真实示例</a></div>
      </div>
      {failed ? (
        <section className="p2md-site-startup-error" role="alert">
          <h1>阅读器未能启动</h1>
          <p>请刷新页面后重试；你的本地文件不会上传到 Paper2MD，也不会写入浏览器持久存储。</p>
          <a className="site-primary reader-error-link" href="/">返回首页</a>
        </section>
      ) : (
        <div ref={root} className="site-reader-root" aria-label="Paper2MD 只读 Reader" />
      )}
    </main>
  );
}
