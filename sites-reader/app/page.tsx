"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserPdfPackageResult } from "../../apps/web/src/browser-pdf-processor";
import type { ReaderFileSystem } from "../../src/filesystem/reader-file-system";

type ReaderView = "demo" | "local" | "workbench";
type WorkbenchStatus = { tone: "working" | "error" | "ready"; message: string };

const DEMO_MARKDOWN = `# 浏览器内的 After‑MinerU 工作台

After‑MinerU by Paper2MD 把**大纲、正文、图表与原 PDF 参考视图**放在同一阅读空间。这个示例完全在浏览器内运行。

## 1. 文件边界

你可以打开 Markdown、Paper2MD / MinerU 论文包、ZIP 或明确授权的目录。原文件保持不变，显示修正只形成派生阅读投影或 sidecar。

## 2. 图文同步

已有论文包中的图表、图注和页码会在确定性契约通过后进入 Reader；无法唯一验证的关系不会被猜测。

![Paper2MD Reader 的图文同步界面](images/reader-overview.png)

Figure 1. 内置演示使用随站点发布的安全数据，不读取设备文件。

## 3. 在线转换边界

Paper2MD 不托管论文。浏览器本地解析不会上传 PDF；选择 MinerU 在线处理时，PDF 会直接发送给 MinerU。当前浏览器直连检测未通过，因此 MinerU 快速与精准转换保持停用。
`;

async function createDemoFileSystem(): Promise<ReaderFileSystem> {
  const [{ BrowserDirectoryReaderFileSystem }, imageResponse] = await Promise.all([
    import("../../src/filesystem/browser-directory-reader-file-system"),
    fetch("/og.png", { cache: "force-cache" })
  ]);
  if (!imageResponse.ok) throw new Error("Demo image is unavailable");
  const image = await imageResponse.blob();
  return BrowserDirectoryReaderFileSystem.fromFileMap("Paper2MD 内置演示", new Map([
    ["article.md", new File([DEMO_MARKDOWN], "article.md", { type: "text/markdown" })],
    ["images/reader-overview.png", new File([image], "reader-overview.png", { type: "image/png" })]
  ]));
}

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

async function writeFile(directory: FileSystemDirectoryHandle, path: string, file: File): Promise<void> {
  const segments = path.split("/");
  const filename = segments.pop();
  if (!filename) throw new Error("无效的导出路径。");
  let target = directory;
  for (const segment of segments) target = await target.getDirectoryHandle(segment, { create: true });
  const handle = await target.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
}

export default function Home() {
  const [readerView, setReaderView] = useState<ReaderView | null>(null);
  const [failed, setFailed] = useState(false);
  const [directorySupported, setDirectorySupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [pdfResult, setPdfResult] = useState<BrowserPdfPackageResult | null>(null);
  const readerRoot = useRef<HTMLDivElement>(null);

  useEffect(() => { setDirectorySupported("showDirectoryPicker" in window); }, []);

  useEffect(() => {
    if (!readerView || !readerRoot.current) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    const initial = readerView === "demo"
      ? createDemoFileSystem()
      : Promise.resolve(readerView === "workbench" ? pdfResult?.fileSystem : undefined);
    void Promise.all([import("../../local-reader/main"), initial])
      .then(([{ mountLocalReader }, initialFileSystem]) => {
        if (!cancelled && readerRoot.current) dispose = mountLocalReader(readerRoot.current, { initialFileSystem, enableWebMcp: false, enableProcessingApi: false });
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
    if (!pdfResult) return;
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) { setStatus({ tone: "error", message: "当前浏览器不支持目录写入，请改用 ZIP 下载。" }); return; }
    try {
      const root = await picker.call(window, { mode: "readwrite" });
      const folder = await root.getDirectoryHandle(pdfResult.archiveName.replace(/\.paper2md\.zip$/i, ""), { create: true });
      for (const [path, file] of pdfResult.files) await writeFile(folder, path, file);
      setStatus({ tone: "ready", message: "结果已写入你明确授权的目录。" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (readerView) {
    const label = readerView === "demo" ? "内置演示 · 不读取设备文件" : readerView === "workbench" ? "浏览器本地 PDF 投影 · 原文件不变" : "本地论文工作台 · 无云端论文库";
    return (
      <main className="site-reader-shell">
        <div className="site-reader-bar">
          <button type="button" onClick={() => setReaderView(null)} aria-label="返回首页">← After‑MinerU</button><span>{label}</span>
          <div className="reader-bar-actions">
            {readerView === "workbench" && pdfResult ? <><button type="button" onClick={() => void downloadResult()}>下载 ZIP</button><button type="button" onClick={() => void writeResult()} disabled={!directorySupported}>写入目录</button></> : <button type="button" onClick={() => openReader(readerView === "demo" ? "local" : "demo")}>{readerView === "demo" ? "打开本地论文" : "查看演示"}</button>}
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

      <section className="site-entry-grid" aria-label="工作台入口"><a href="#quick"><span>01</span><b>快速转换</b><small>本地文本投影可用；MinerU Agent 暂停</small></a><a href="#precision"><span>02</span><b>精准转换</b><small>本地链路已验证；网页直连待开放</small></a><button type="button" onClick={() => openReader("local")}><span>03</span><b>打开本地论文</b><small>目录、Markdown、ZIP / 论文包</small></button><a href="#clipper"><span>04</span><b>网页剪藏</b><small>扩展读取当前标签页并导出 ZIP</small></a><a href="#desktop"><span>05</span><b>下载桌面版</b><small>安全凭据、索引与长期论文库</small></a><a href="#docs"><span>06</span><b>使用文档</b><small>能力、隐私与兼容性说明</small></a></section>

      <section className="site-workbench" id="quick" aria-labelledby="quick-title"><div className="workbench-copy"><p className="site-kicker">快速转换</p><h2 id="quick-title">先在本机生成文本投影，再进入 Reader。</h2><p>当前可用路径直接在浏览器内读取 PDF 文本层，保留原 PDF 作为参考，并执行现有 Reader 的安全校验。它不会猜测复杂图注或视觉关系；扫描件、复杂表格和无文本层页面请使用桌面版。</p><label className="site-primary file-action">选择 PDF<input type="file" accept=".pdf,application/pdf" onChange={(event) => { void processPdf(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>{status ? <p className={`workbench-status ${status.tone}`} role="status">{status.message}</p> : null}</div><div className="conversion-rail"><div className="conversion-option available"><span>可用</span><h3>浏览器本地 PDF 投影</h3><p>≤64MB、≤200页；生成 Markdown、保留 source.pdf，可下载 ZIP 或写入授权目录。</p></div><div className="conversion-option blocked"><span>直连检测未通过</span><h3>MinerU Agent 轻量接口</h3><p>官方限制为单文件、10MB、20页、仅 Markdown。2026-08-28 实测 API 跨域预检返回 405，因此未启用上传。</p></div></div></section>

      <section className="site-precision" id="precision" aria-labelledby="precision-title"><div><p className="site-kicker">精准转换 · 实验性</p><h2 id="precision-title">本地完整链路已验证，网页入口仍安全关闭。</h2><p>MinerU 精准 API 需要用户自己的 Token，并会把所选 PDF 直接上传到 MinerU。2026-08-28 使用官方 13 页示例在桌面本地完成签名上传、轮询、ZIP 下载与结构校验；但带 Authorization 的浏览器跨域预检仍返回 405，所以网页不显示 Token 输入框、不收集 Token，也没有增加 Paper2MD 云代理。</p><a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">查看 MinerU Token 管理</a></div><aside><b>本地验证：通过 · 网页直连：关闭</b><ol><li>本地签名 PUT：通过</li><li>本地轮询与 ZIP 下载：通过</li><li>结果校验：1 Markdown / 4 JSON / 20 图片</li><li>浏览器 API 预检：未通过</li></ol><p>本地成功不能替代浏览器 CORS 验证。完整精准提取与安全 Token 存储仍属于桌面版。</p></aside></section>

      <section className="site-preview" aria-label="阅读器能力预览"><div className="site-preview-copy"><p className="site-kicker">临时阅读</p><h2>大纲、正文与图表并排，原 PDF 可作参考。</h2><p>导入具备 MinerU JSON、Reader contract 或 sidecar 的论文包时，网页会复用现有确定性投影和视觉修复；冲突或证据不足时保留原始显示。</p><button type="button" onClick={() => openReader("demo")}>打开内置示例 <span aria-hidden="true">↗</span></button></div><div className="site-preview-ui" aria-hidden="true"><div className="preview-chrome"><i></i><i></i><i></i><b>After‑MinerU Reader</b></div><div className="preview-workspace"><div className="preview-outline"><b>Outline</b><em>摘要</em><em className="active">方法</em><em>结果</em><em>讨论</em></div><div className="preview-paper"><small>METHODS</small><b>Structured reading</b><span></span><span></span><span></span><div className="preview-inline-figure"></div><span></span></div><div className="preview-figure"><b>Figures / PDF</b><div></div><small>Figure 1</small></div></div></div></section>

      <section className="site-clipper" id="clipper" aria-labelledby="clipper-title"><div><p className="site-kicker">网页剪藏</p><h2 id="clipper-title">扩展读取当前论文标签页，网页本身不越权。</h2><p>Paper2MD Web Clipper 只在你点击扩展时读取当前标签页，复用 clipper-core 在本地生成 Markdown、图片和清单，然后导出 ZIP，再由你打开到网页 Reader。</p></div><ul><li>不绕过登录、付费墙、验证码或网站权限</li><li>网页不能跨源读取其他标签页</li><li>图片按来源逐项授权并省略不安全资源</li><li>ZIP 是本地交付，不进入 Paper2MD 云端论文库</li></ul></section>

      <section className="site-boundaries" aria-labelledby="boundaries-title"><div className="site-section-heading"><p className="site-kicker">能力边界</p><h2 id="boundaries-title">网页负责临时工作，桌面端负责长期系统。</h2></div><div className="site-compare" role="table" aria-label="网页工作台与桌面端能力对比"><div className="compare-head" role="row"><span role="columnheader">能力</span><b role="columnheader">网页工作台</b><b role="columnheader">桌面版</b></div><div role="row"><span role="cell">处理与阅读</span><b role="cell">本地文本投影、包校验、临时 Reader</b><b role="cell">完整精准提取、Reader 与任务管理</b></div><div role="row"><span role="cell">数据</span><b role="cell">内存会话、ZIP 或授权目录；无云端论文库</b><b role="cell">本地论文库、索引与长期存储</b></div><div role="row"><span role="cell">凭据</span><b role="cell">当前不采集 Token；实验路径安全关闭</b><b role="cell">本机安全凭据与 MinerU 配置</b></div><div role="row"><span role="cell">自动化</span><b role="cell">不以 MCP / Agent 为依赖</b><b role="cell">Processing Service、MCP 与完整工作流</b></div></div></section>

      <section className="site-local" aria-labelledby="local-title"><div><p className="site-kicker">本地目录模式</p><h2 id="local-title">读取和写入都由你明确发起。</h2><p>支持 File System Access API 的 Chromium 浏览器可以读取或写入你选择的目录；其他浏览器降级为文件/ZIP 导入与 ZIP 下载。站点默认不使用 IndexedDB 保存论文。</p><button className="site-primary" type="button" onClick={() => openReader("local")}>打开本地论文</button></div><aside aria-label="当前浏览器兼容性"><span className={directorySupported ? "support-dot supported" : "support-dot"} aria-hidden="true"></span><div><b>{directorySupported === null ? "正在检查目录能力" : directorySupported ? "当前浏览器支持目录授权" : "当前浏览器使用文件 / ZIP 降级"}</b><p>{directorySupported ? "只有点击选择并确认后，网页才会获得目录权限。" : "阅读仍可使用；结果请通过 ZIP 下载。"}</p></div></aside></section>

      <section className="site-desktop" id="desktop" aria-labelledby="desktop-title"><div><p className="site-kicker">Paper2MD Reader Desktop · v0.1.3</p><h2 id="desktop-title">安全凭据、完整提取和长期论文库留在桌面端。</h2><p>桌面版提供 MinerU Token 的本机配置、完整精准提取、本地索引、长期论文库、处理任务与 MCP。公开安装包地址尚未开放，我们不会编造下载链接。</p><div className="site-actions-left"><button className="site-disabled" type="button" disabled>公开下载即将开放</button><a href="#docs">先阅读使用说明</a></div></div><div className="desktop-card" aria-label="桌面版主要能力"><span>DESKTOP</span><b>完整工作流</b><p>安全凭据与精准提取</p><p>本地论文库与索引</p><p>派生投影、sidecar 与 MCP</p></div></section>

      <section className="site-docs" id="docs" aria-labelledby="docs-title"><div className="site-section-heading"><p className="site-kicker">使用文档</p><h2 id="docs-title">知道文件去哪，才开始处理。</h2></div><div className="site-doc-grid"><article><span>01</span><h3>本地 PDF</h3><p>网页读取文本层并生成派生 Markdown；复杂视觉关系不确定时保持关闭，可在 Reader 中对照原 PDF。</p><a href="#quick">开始本地投影</a></article><article><span>02</span><h3>论文包与 ZIP</h3><p>支持 Markdown、Paper2MD / MinerU 结果目录和 ZIP；已有确定性契约会被校验后用于显示。</p><button type="button" onClick={() => openReader("local")}>打开 Reader</button></article><article><span>03</span><h3>隐私与导出</h3><p>论文不进入 Paper2MD 云端库；结果下载为 ZIP，或写入你明确授权的本地目录。</p><a href="#privacy">查看数据边界</a></article></div></section>

      <section className="site-privacy" id="privacy" aria-labelledby="privacy-title"><p className="site-kicker">隐私与数据边界</p><h2 id="privacy-title">Paper2MD 不托管，也不长期保存你的论文。</h2><div><p><b>本地路径</b><span>目录、Markdown、ZIP 和浏览器本地 PDF 投影仅在当前设备处理；默认不写 IndexedDB。</span></p><p><b>MinerU 路径</b><span>未来若直连能力通过，只有你主动选择时 PDF 才会直接上传 MinerU；Paper2MD 不经手。</span></p><p><b>临时 Token</b><span>当前因跨域检测失败而不提供输入。未来实验模式也只允许页面内存，并明确低于桌面凭据库安全级别。</span></p><p><b>源文件不可变</b><span>修复只生成派生投影或 sidecar；契约冲突、证据不足或链路不完整时安全关闭。</span></p></div></section>

      <footer className="site-footer"><a className="site-brand" href="#top">After‑<span>MinerU</span><small>by Paper2MD</small></a><p>独立第三方工具，非 MinerU 官方产品。Online conversion, local reading, portable results.</p><button type="button" onClick={() => openReader("demo")}>查看演示 →</button></footer>
    </main>
  );
}
