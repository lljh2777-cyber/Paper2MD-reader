"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserPdfPackageResult } from "../../apps/web/src/browser-pdf-processor";
import {
  CHROME_WEB_STORE_URL,
  MINERU_API_DOCS_URL,
  MINERU_PROJECT_URL,
  PROJECT_REPOSITORY_URL,
  ProjectLinks
} from "./project-links";

type ReaderView = "local" | "workbench";
type WorkbenchStatus = { tone: "working" | "error" | "ready"; message: string };

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function packageZip(result: BrowserPdfPackageResult): Promise<Blob> {
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  await Promise.all([...result.files].map(async ([path, file]) => {
    entries[path] = new Uint8Array(await file.arrayBuffer());
  }));
  const zipped = zipSync(entries, { level: 6 });
  return new Blob([zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer], { type: "application/zip" });
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

export default function Home() {
  const [readerView, setReaderView] = useState<ReaderView | null>(null);
  const [failed, setFailed] = useState(false);
  const [directorySupported, setDirectorySupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [pdfResult, setPdfResult] = useState<BrowserPdfPackageResult | null>(null);
  const [directoryWriting, setDirectoryWriting] = useState(false);
  const readerRoot = useRef<HTMLDivElement>(null);
  const directoryWriteBusy = useRef(false);

  useEffect(() => { setDirectorySupported("showDirectoryPicker" in window); }, []);

  useEffect(() => {
    if (!readerView || !readerRoot.current) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    const initial = Promise.resolve(readerView === "workbench" ? pdfResult?.fileSystem : undefined);
    void Promise.all([import("../../local-reader/main"), initial])
      .then(([{ mountLocalReader }, initialFileSystem]) => {
        if (!cancelled && readerRoot.current) dispose = mountLocalReader(readerRoot.current, {
          initialFileSystem,
          enableWebMcp: false,
          enableProcessingApi: false,
          persistPaperState: false
        });
      })
      .catch((error: unknown) => { console.error("Paper2MD Reader failed to start", error); setFailed(true); });
    return () => { cancelled = true; dispose?.(); };
  }, [readerView, pdfResult]);

  const openReader = (view: ReaderView) => { setFailed(false); setReaderView(view); };

  const processPdf = async (file: File | undefined) => {
    if (!file) return;
    setStatus({ tone: "working", message: "正在浏览器内读取 PDF…" });
    try {
      const { processBrowserPdf } = await import("../../apps/web/src/browser-pdf-processor");
      const result = await processBrowserPdf(file, (progress) => setStatus({ tone: "working", message: progress.message }));
      setPdfResult(result);
      setStatus({ tone: "ready", message: `已生成 ${result.pageCount} 页的本地阅读投影，共提取 ${result.extractedCharacterCount.toLocaleString()} 个字符。` });
      openReader("workbench");
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const downloadResult = async () => {
    if (!pdfResult) return;
    setStatus({ tone: "working", message: "正在浏览器内生成 ZIP…" });
    try { downloadBlob(await packageZip(pdfResult), pdfResult.archiveName); setStatus({ tone: "ready", message: "ZIP 已生成；论文没有上传到 Paper2MD。" }); }
    catch (error) { setStatus({ tone: "error", message: error instanceof Error ? error.message : String(error) }); }
  };

  const writeResult = async () => {
    if (!pdfResult || directoryWriteBusy.current) return;
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) { setStatus({ tone: "error", message: "当前浏览器不支持目录写入，请改用 ZIP 下载。" }); return; }
    directoryWriteBusy.current = true;
    setDirectoryWriting(true);
    try {
      const root = await picker.call(window, { mode: "readwrite" });
      const { writePackageToFreshDirectory } = await import("../../apps/web/src/browser-directory-export");
      const result = await writePackageToFreshDirectory(
        root,
        pdfResult.archiveName.replace(/\.paper2md\.zip$/i, ""),
        pdfResult.files
      );
      setStatus({ tone: "ready", message: `结果已写入随机新目录 ${result.folderName}；检测到冲突时会停止。` });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      directoryWriteBusy.current = false;
      setDirectoryWriting(false);
    }
  };

  if (readerView) {
    const label = readerView === "workbench" ? "浏览器本地 PDF 投影 · 原文件不变" : "本地论文工作台 · 无云端论文库";
    return (
      <main className="site-reader-shell">
        <div className="site-reader-bar">
          <button type="button" onClick={() => setReaderView(null)} aria-label="返回首页">← After‑MinerU</button><span>{label}</span>
          <div className="reader-bar-actions">
            {readerView === "workbench" && pdfResult ? <><button type="button" onClick={() => void downloadResult()}>下载 ZIP</button><button type="button" onClick={() => void writeResult()} disabled={!directorySupported || directoryWriting}>{directoryWriting ? "正在写入…" : "写入新目录"}</button></> : <a href="/demo/debyecalculator">查看真实示例</a>}
          </div>
        </div>
        {status && readerView === "workbench" ? <div className={`site-reader-status ${status.tone}`} role="status">{status.message}</div> : null}
        {failed ? <section className="p2md-site-startup-error" role="alert"><h1>阅读器未能启动</h1><p>请刷新页面后重试；你的本地文件不会上传到 Paper2MD。</p><button className="site-primary" type="button" onClick={() => setReaderView(null)}>返回首页</button></section> : <div ref={readerRoot} className={`site-reader-root${status && readerView === "workbench" ? " has-status" : ""}`} aria-live="polite" />}
      </main>
    );
  }

  return (
    <main className="site-home">
      <header className="site-nav"><a className="site-brand" href="#top" aria-label="After-MinerU 首页">After‑<span>MinerU</span><small>by Paper2MD</small></a><nav aria-label="主要导航"><a href="#quick">快速转换</a><a href="#precision">精准转换</a><button className="site-nav-local" type="button" onClick={() => openReader("local")}>打开本地论文</button><a href="#clipper">网页剪藏</a><a href="#desktop">下载桌面版</a><a href="#docs">文档</a></nav></header>

      <section className="site-hero" id="top"><p className="site-eyebrow">LOCAL PROCESSING WORKBENCH</p><h1>在线转换、临时阅读，<br />结果仍由你带走。</h1><p className="site-lede">在浏览器内打开 PDF、Markdown、ZIP 或论文目录，生成派生阅读投影并导出。Paper2MD 不提供云端论文库，也不长期保存你的论文。</p><div className="site-actions"><a className="site-primary" href="#quick">处理一篇 PDF <span aria-hidden="true">→</span></a><button className="site-secondary" type="button" onClick={() => openReader("local")}>打开本地论文</button></div><p className="site-boundary"><span aria-hidden="true">●</span> 浏览器本地解析不上传；MinerU 在线处理只有在你选择且直连能力通过时才会上传。</p></section>

      <section className="site-entry-grid" aria-label="工作台入口"><a href="#quick"><span>01</span><b>快速转换</b><small>本地文本投影可用；MinerU Agent 暂停</small></a><a href="#precision"><span>02</span><b>精准转换</b><small>Chrome 商店版 0.2.0 已正式发布</small></a><button type="button" onClick={() => openReader("local")}><span>03</span><b>打开本地论文</b><small>目录、Markdown、Paper2MD / .mineru.zip</small></button><a href="#clipper"><span>04</span><b>网页剪藏</b><small>开发者版 Companion 导出 ZIP</small></a><a href="#desktop"><span>05</span><b>下载桌面版</b><small>安全凭据、索引与长期论文库</small></a><a href="#docs"><span>06</span><b>使用文档</b><small>能力、隐私与兼容性说明</small></a></section>

      <section className="site-workbench" id="quick" aria-labelledby="quick-title"><div className="workbench-copy"><p className="site-kicker">快速转换</p><h2 id="quick-title">先在本机生成文本投影，再进入 Reader。</h2><p>当前可用路径直接在浏览器内读取 PDF 文本层，保留原 PDF 作为参考，并执行现有 Reader 的安全校验。它不会猜测复杂图注或视觉关系；扫描件、复杂表格和无文本层页面请使用桌面版。</p><label className="site-primary file-action">选择 PDF<input type="file" accept=".pdf,application/pdf" onChange={(event) => { void processPdf(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>{status ? <p className={`workbench-status ${status.tone}`} role="status">{status.message}</p> : null}</div><div className="conversion-rail"><div className="conversion-option available"><span>可用</span><h3>浏览器本地 PDF 投影</h3><p>≤64MB、≤200页；生成 Markdown、保留 source.pdf，可下载 ZIP 或写入授权目录。</p></div><div className="conversion-option blocked"><span>普通网页暂不可用</span><h3>MinerU Agent 轻量接口</h3><p>MinerU Agent 轻量接口目前未允许本站完成浏览器跨域请求，因此网页端暂不提供该上传入口。精准转换仍可通过 Chrome 扩展使用。</p></div></div></section>

      <section className="site-precision" id="precision" aria-labelledby="precision-title"><div><p className="site-kicker">精准转换 · 独立 Chrome 扩展</p><h2 id="precision-title">商店版只做一件事：把 PDF 转成可带走的 MinerU ZIP。</h2><p>你的 MinerU Token 会直接用于访问 MinerU API；你选择的 PDF 将直接上传至 MinerU 提供的存储地址，并由 MinerU 服务处理。转换结果随后从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存 Token、PDF及转换结果。请勿上传包含机密、个人隐私或无权处理的文件。</p><p>普通网页的跨域预检仍返回 405，因此本站不显示 Token 输入框。独立的 After‑MinerU Converter 只申请三个固定 MinerU 域名，在扩展页中完成签名上传、轮询、ZIP 下载与本地安全校验；不读取当前标签页、不连接桌面服务，也不使用持久存储。</p><div className="site-actions-left"><a className="site-primary" href={CHROME_WEB_STORE_URL} target="_blank" rel="noreferrer">添加至 Chrome <span aria-hidden="true">↗</span></a><a href="/converter">查看扩展说明</a><a href="/after-mineru-companion-0.1.0.zip" download>下载 Companion 开发者版</a><a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">MinerU Token 管理</a></div><p className="site-install-note">Chrome 商店版 0.2.0 已公开发布，可一键安装；现有 ZIP 仍是包含网页剪藏功能的 Companion 开发者测试版，不是 Chrome Web Store 安装包。详见 <a href="/privacy">隐私政策</a>与 <a href="/support">扩展支持</a>。</p></div><aside><b>Chrome 商店版 0.2.0 · 已公开发布</b><ol><li>按需域名权限与 Token 清除：通过</li><li>MinerU 签名上传、处理与轮询：通过</li><li>OpenXLab 下载及 ZIP 安全校验：通过</li><li>实测结果：1 Markdown / 4 JSON / 2 图片</li></ol><p>扩展会在用户设备内临时处理；Paper2MD 服务器不接收或保存 Token、PDF 或结果。取消只能停止浏览器端请求；MinerU 侧处理和保留仍遵循其政策。</p></aside></section>

      <section className="site-preview" aria-label="阅读器能力预览"><div className="site-preview-copy"><p className="site-kicker">真实论文示例 · CC BY 4.0</p><h2>从原 PDF 到 MinerU，再到派生 Reader。</h2><p>使用一篇 6 页 JOSS 论文逐步展示上传前原 PDF、未经修复的 MinerU ZIP / Markdown，以及通过哈希绑定契约生成的 After‑MinerU 阅读投影。原文件保持字节不变，冲突或证据不足时安全停止。</p><a href="/demo/debyecalculator">查看三阶段真实示例 <span aria-hidden="true">↗</span></a></div><div className="site-preview-ui" aria-hidden="true"><div className="preview-chrome"><i></i><i></i><i></i><b>After‑MinerU Reader</b></div><div className="preview-workspace"><div className="preview-outline"><b>Outline</b><em>Introduction</em><em className="active">Implementation</em><em>Example use cases</em><em>Conclusion</em></div><div className="preview-paper"><small>JOSS · 2024</small><b>DebyeCalculator</b><span></span><span></span><span></span><div className="preview-inline-figure"></div><span></span></div><div className="preview-figure"><b>Figures / PDF</b><div></div><small>Figure 3 · repaired</small></div></div></div></section>

      <section className="site-clipper" id="clipper" aria-labelledby="clipper-title"><div><p className="site-kicker">After‑MinerU Companion · 开发者版</p><h2 id="clipper-title">网页剪藏与商店版精准转换分开发布。</h2><p>Chrome 商店版保持单一用途，只处理你选择的 PDF。网页剪藏继续留在 Companion 开发者版：仅在你点击时读取当前标签页，复用 clipper-core 在本地生成 Markdown、图片和清单，再导出 ZIP 或发送到已配对的桌面版。</p></div><ul><li>商店版不读取当前标签页，也不包含桌面配对</li><li>剪藏不绕过登录、付费墙、验证码或网站权限</li><li>精准 Token 不写 localStorage、扩展持久存储或日志</li><li>ZIP 是本地交付，不进入 Paper2MD 云端论文库</li></ul></section>

      <section className="site-boundaries" aria-labelledby="boundaries-title"><div className="site-section-heading"><p className="site-kicker">能力边界</p><h2 id="boundaries-title">网页负责临时工作，桌面端负责长期系统。</h2></div><div className="site-compare" role="table" aria-label="网页工作台与桌面端能力对比"><div className="compare-head" role="row"><span role="columnheader">能力</span><b role="columnheader">网页工作台 / 扩展</b><b role="columnheader">桌面版</b></div><div role="row"><span role="cell">处理与阅读</span><b role="cell">本地投影、扩展精准转换、包校验、临时 Reader</b><b role="cell">完整精准提取、Reader 与任务管理</b></div><div role="row"><span role="cell">数据</span><b role="cell">内存会话、ZIP 或授权目录；无云端论文库</b><b role="cell">本地论文库、索引与长期存储</b></div><div role="row"><span role="cell">凭据</span><b role="cell">扩展页临时内存；任务后清除，不等同安全凭据库</b><b role="cell">本机安全凭据与 MinerU 配置</b></div><div role="row"><span role="cell">自动化</span><b role="cell">不以 MCP / Agent 为依赖</b><b role="cell">Processing Service、MCP 与完整工作流</b></div></div></section>

      <section className="site-local" aria-labelledby="local-title"><div><p className="site-kicker">本地目录模式</p><h2 id="local-title">读取和写入都由你明确发起。</h2><p>支持 File System Access API 的 Chromium 浏览器可以读取或写入你选择的目录；其他浏览器降级为文件/ZIP 导入与 ZIP 下载。站点默认不使用 IndexedDB 保存论文。</p><button className="site-primary" type="button" onClick={() => openReader("local")}>打开本地论文</button></div><aside aria-label="当前浏览器兼容性"><span className={directorySupported ? "support-dot supported" : "support-dot"} aria-hidden="true"></span><div><b>{directorySupported === null ? "正在检查目录能力" : directorySupported ? "当前浏览器支持目录授权" : "当前浏览器使用文件 / ZIP 降级"}</b><p>{directorySupported ? "只有点击选择并确认后，网页才会获得目录权限。" : "阅读仍可使用；结果请通过 ZIP 下载。"}</p></div></aside></section>

      <section className="site-desktop" id="desktop" aria-labelledby="desktop-title"><div><p className="site-kicker">Paper2MD Reader Desktop · v0.1.3</p><h2 id="desktop-title">安全凭据、完整提取和长期论文库留在桌面端。</h2><p>桌面版提供 MinerU Token 的本机配置、完整精准提取、本地索引、长期论文库、处理任务与 MCP。公开安装包地址尚未开放，我们不会编造下载链接。</p><div className="site-actions-left"><button className="site-disabled" type="button" disabled>公开下载即将开放</button><a href="#docs">先阅读使用说明</a></div></div><div className="desktop-card" aria-label="桌面版主要能力"><span>DESKTOP</span><b>完整工作流</b><p>安全凭据与精准提取</p><p>本地论文库与索引</p><p>派生投影、sidecar 与 MCP</p></div></section>

      <section className="site-docs" id="docs" aria-labelledby="docs-title"><div className="site-section-heading"><p className="site-kicker">使用文档</p><h2 id="docs-title">知道文件去哪，才开始处理。</h2></div><div className="site-doc-grid"><article><span>01</span><h3>本地 PDF</h3><p>网页读取文本层并生成派生 Markdown；复杂视觉关系不确定时保持关闭，可在 Reader 中对照原 PDF。</p><a href="#quick">开始本地投影</a></article><article><span>02</span><h3>论文包与 ZIP</h3><p>支持 Markdown、Paper2MD 包、MinerU 结果目录及 <code>.mineru.zip</code>；普通 <code>.zip</code> 仍按剪藏 / Paper2MD 格式校验，不混用解析边界。</p><button type="button" onClick={() => openReader("local")}>打开 Reader</button></article><article><span>03</span><h3>隐私与导出</h3><p>论文不进入 Paper2MD 云端库；ZIP 下载最稳妥。目录导出每次创建随机新目录并在冲突时停止，但浏览器 API 不能为其他标签页的同时写入提供原子排他保证。</p><a href="#privacy">查看数据边界</a></article></div></section>

      <section className="site-privacy" id="privacy" aria-labelledby="privacy-title"><p className="site-kicker">隐私与数据边界</p><h2 id="privacy-title">Paper2MD 不托管，也不长期保存你的论文。</h2><div><p><b>本地路径</b><span>目录、Markdown、ZIP 和浏览器本地 PDF 投影仅在当前设备处理；默认不写 IndexedDB。</span></p><p><b>MinerU 路径</b><span>你的 Token 直接用于访问 MinerU API；所选 PDF 直传 MinerU 提供的存储地址并由 MinerU 处理，结果从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存这些数据。请勿上传机密、含个人隐私或无权处理的文件。</span></p><p><b>本页临时持有 Token</b><span>普通网页不提供输入。商店扩展不持久保存 Token；Token 本身持续有效，直到你在 MinerU 吊销，安全级别仍低于桌面凭据库。</span></p><p><b>源文件不可变</b><span>扩展校验后下载 MinerU 原始 ZIP；修复只生成派生投影或 sidecar，冲突、证据不足或链路不完整时安全关闭。</span></p></div><div className="site-actions-left"><a href="/privacy">阅读完整隐私政策</a><a href="/support">扩展支持</a></div></section>

      <section className="site-credits" aria-labelledby="credits-title">
        <div><p className="site-kicker">开源与致谢</p><h2 id="credits-title">说明来源，也说明边界。</h2></div>
        <div className="site-credits-copy">
          <p>After‑MinerU 是 <a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer">Paper2MD Reader</a> 项目中的独立第三方工具，兼容 <a href={MINERU_API_DOCS_URL} target="_blank" rel="noreferrer">MinerU API</a> 及其结果包格式，并在用户设备中完成校验、确定性修复与阅读投影。</p>
          <p>感谢 <a href={MINERU_PROJECT_URL} target="_blank" rel="noreferrer">MinerU / OpenDataLab</a> 团队提供文档解析能力和公开技术资料。本项目与 MinerU、OpenDataLab、OpenXLab 不存在隶属、赞助或背书关系。</p>
        </div>
      </section>

      <footer className="site-footer"><a className="site-brand" href="#top">After‑<span>MinerU</span><small>by Paper2MD</small></a><div className="site-footer-copy"><p>独立第三方工具。Online conversion, local reading, portable results.</p><ProjectLinks includeDemo /></div></footer>
    </main>
  );
}
