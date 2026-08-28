"use client";

import { useEffect, useRef, useState } from "react";

type View = "home" | "demo" | "local";

const DEMO_MARKDOWN = `# 让论文阅读回到内容本身

Paper2MD Reader 把论文的**大纲、正文与图表**放在同一阅读工作区。这个内置示例完全在浏览器中运行，不需要登录，也不会连接论文处理服务。

## 1. 本地优先的阅读路径

打开本地论文时，浏览器只读取你明确选择的目录、Markdown 或 Paper2MD ZIP。网页不会索取 MinerU Token，也不会把论文上传到 Paper2MD 的服务器。

## 2. 图文同步

滚动正文时，右侧图表视图可以跟随当前阅读位置；你也可以从图表回到正文中的引用位置。

![Paper2MD Reader 的图文同步界面](images/reader-overview.png)

Figure 1. Paper2MD Reader 的内置演示界面。演示使用随站点发布的安全数据，不读取设备文件。

## 3. 能力边界

| 浏览器轻量版 | 桌面版 |
| --- | --- |
| 内置演示、本地目录、Markdown 与 ZIP 阅读 | 完整论文处理与管理工作流 |
| 不采集 Token，不长期连接 localhost | 用户可自行配置 MinerU Token |
| 原始文件只读，修复仅存在于派生阅读投影 | 可生成受校验的派生投影与 sidecar |

## 4. 下一步

返回首页后选择“打开本地论文”，即可在明确授权后阅读自己的 Paper2MD 或 MinerU 结果包。
`;

async function createDemoFileSystem() {
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

export default function Home() {
  const [view, setView] = useState<View>("home");
  const [failed, setFailed] = useState(false);
  const [directorySupported, setDirectorySupported] = useState<boolean | null>(null);
  const readerRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDirectorySupported("showDirectoryPicker" in window);
  }, []);

  useEffect(() => {
    if (view === "home" || !readerRoot.current) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void Promise.all([
      import("../../local-reader/main"),
      view === "demo" ? createDemoFileSystem() : Promise.resolve(undefined)
    ])
      .then(([{ mountLocalReader }, initialFileSystem]) => {
        if (!cancelled && readerRoot.current) {
          dispose = mountLocalReader(readerRoot.current, { initialFileSystem, enableWebMcp: false });
        }
      })
      .catch((error: unknown) => {
        console.error("Paper2MD Reader failed to start", error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [view]);

  const openView = (nextView: View) => {
    setFailed(false);
    setView(nextView);
  };

  if (view !== "home") {
    return (
      <main className="site-reader-shell">
        <div className="site-reader-bar">
          <button type="button" onClick={() => openView("home")} aria-label="返回首页">← Paper2MD Reader</button>
          <span>{view === "demo" ? "内置演示 · 不读取设备文件" : "浏览器轻量版 · 文件只在本机读取"}</span>
          <button type="button" onClick={() => openView(view === "demo" ? "local" : "demo")}>
            {view === "demo" ? "打开本地论文" : "查看内置演示"}
          </button>
        </div>
        {failed ? (
          <section className="p2md-site-startup-error" role="alert">
            <h1>阅读器未能启动</h1>
            <p>请刷新页面后重试；你的本地文件不会被上传。</p>
            <button className="site-primary" type="button" onClick={() => openView("home")}>返回首页</button>
          </section>
        ) : <div ref={readerRoot} className="site-reader-root" aria-live="polite" />}
      </main>
    );
  }

  return (
    <main className="site-home">
      <header className="site-nav">
        <a className="site-brand" href="#top" aria-label="Paper2MD Reader 首页">Paper2MD <span>Reader</span></a>
        <nav aria-label="主要导航">
          <button type="button" onClick={() => openView("demo")}>在线体验</button>
          <button type="button" onClick={() => openView("local")}>打开本地论文</button>
          <a href="#desktop">下载桌面版</a>
          <a href="#docs">使用文档</a>
        </nav>
      </header>

      <section className="site-hero" id="top">
        <p className="site-eyebrow">LOCAL FIRST · CLOUD OPTIONAL</p>
        <h1>把论文留在本地，<br />把阅读体验带到浏览器。</h1>
        <p className="site-lede">在线演示和阅读已处理好的论文包无需安装、登录或 Token。只有在桌面端调用 MinerU 处理新 PDF 时，才需前往 MinerU 官网申请并在本机配置 API Token。</p>
        <div className="site-actions">
          <button className="site-primary" type="button" onClick={() => openView("demo")}>在线体验 <span aria-hidden="true">→</span></button>
          <button className="site-secondary" type="button" onClick={() => openView("local")}>打开本地论文</button>
        </div>
        <p className="site-boundary"><span aria-hidden="true">●</span> 这是本地优先的轻量 Reader，不是云端论文处理服务。</p>
      </section>

      <section className="site-preview" aria-label="阅读器能力预览">
        <div className="site-preview-copy">
          <p className="site-kicker">阅读工作区</p>
          <h2>大纲、正文与图表并排，专注理解而不是整理窗口。</h2>
          <p>网页端保留最重要的阅读体验：章节导航、Markdown 正文、图表跟随与参考视图。桌面与移动端会自动调整布局。</p>
          <button type="button" onClick={() => openView("demo")}>打开内置示例 <span aria-hidden="true">↗</span></button>
        </div>
        <div className="site-preview-ui" aria-hidden="true">
          <div className="preview-chrome"><i></i><i></i><i></i><b>Paper2MD Reader</b></div>
          <div className="preview-workspace">
            <div className="preview-outline"><b>Outline</b><em>摘要</em><em className="active">方法</em><em>结果</em><em>讨论</em></div>
            <div className="preview-paper"><small>METHODS</small><b>Structured reading</b><span></span><span></span><span></span><div className="preview-inline-figure"></div><span></span></div>
            <div className="preview-figure"><b>Figures</b><div></div><small>Figure 1</small></div>
          </div>
        </div>
      </section>

      <section className="site-path" id="experience" aria-labelledby="path-title">
        <div className="site-section-heading">
          <p className="site-kicker">第一次使用</p>
          <h2 id="path-title">三步开始，没有设置迷宫。</h2>
        </div>
        <div className="site-steps">
          <article><span>01</span><h3>先看演示</h3><p>用内置论文理解大纲、正文和图表如何协同；不读取任何设备文件。</p></article>
          <article><span>02</span><h3>明确选择</h3><p>打开一个本地目录、Markdown 或 Paper2MD ZIP；浏览器只获得你主动选择的内容。</p></article>
          <article><span>03</span><h3>专注阅读</h3><p>在浏览器内导航章节与图表。刷新或关闭页面后，网页不继续控制你的目录。</p></article>
        </div>
      </section>

      <section className="site-local" aria-labelledby="local-title">
        <div>
          <p className="site-kicker">浏览器本地模式</p>
          <h2 id="local-title">权限由你发起，文件留在设备。</h2>
          <p>支持 File System Access API 的桌面浏览器可在你确认后读取所选目录。其他浏览器仍可导入 Markdown、论文包或 ZIP；浏览器兼容性不同，功能会自动降级。</p>
          <button className="site-primary" type="button" onClick={() => openView("local")}>选择本地论文</button>
        </div>
        <aside aria-label="当前浏览器兼容性">
          <span className={directorySupported ? "support-dot supported" : "support-dot"} aria-hidden="true"></span>
          <div>
            <b>{directorySupported === null ? "正在检查目录能力" : directorySupported ? "当前浏览器支持目录授权" : "当前浏览器使用文件 / ZIP 导入"}</b>
            <p>{directorySupported ? "只有点击选择并确认后，网页才会读取该目录。" : "这是正常的兼容降级；阅读能力不依赖持续目录权限。"}</p>
          </div>
        </aside>
      </section>

      <section className="site-boundaries" aria-labelledby="boundaries-title">
        <div className="site-section-heading">
          <p className="site-kicker">清楚的能力边界</p>
          <h2 id="boundaries-title">网页端轻量，桌面端完整。</h2>
        </div>
        <div className="site-compare" role="table" aria-label="网页端与桌面端能力对比">
          <div className="compare-head" role="row"><span role="columnheader">能力</span><b role="columnheader">浏览器轻量版</b><b role="columnheader">桌面版</b></div>
          <div role="row"><span role="cell">阅读</span><b role="cell">演示、本地包、Markdown、ZIP</b><b role="cell">本地论文库与完整 Reader</b></div>
          <div role="row"><span role="cell">论文处理</span><b role="cell">不提供云端处理</b><b role="cell">本地处理服务，可选 MinerU</b></div>
          <div role="row"><span role="cell">数据与凭据</span><b role="cell">不上传论文，不采集 Token</b><b role="cell">Token 由用户在本机配置</b></div>
          <div role="row"><span role="cell">视觉修复</span><b role="cell">只读取已验证的派生投影</b><b role="cell">可生成受约束 sidecar，冲突时关闭</b></div>
        </div>
      </section>

      <section className="site-desktop" id="desktop" aria-labelledby="desktop-title">
        <div>
          <p className="site-kicker">Paper2MD Reader Desktop · v0.1.3</p>
          <h2 id="desktop-title">需要完整工作流时，回到桌面端。</h2>
          <p>桌面版提供本地论文库、处理任务与经过校验的视觉派生流程。公开安装包地址尚未开放，我们不会用无法验证的链接替代。</p>
          <div className="site-actions-left">
            <button className="site-disabled" type="button" disabled>公开下载即将开放</button>
            <a href="#docs">先阅读使用说明</a>
          </div>
        </div>
        <div className="desktop-card" aria-label="桌面版主要能力">
          <span>DESKTOP</span><b>完整 Reader</b><p>本地论文库</p><p>受控处理任务</p><p>派生投影与 sidecar</p>
        </div>
      </section>

      <section className="site-docs" id="docs" aria-labelledby="docs-title">
        <div className="site-section-heading">
          <p className="site-kicker">使用文档</p>
          <h2 id="docs-title">知道数据去哪，才算真正开始。</h2>
        </div>
        <div className="site-doc-grid">
          <article><span>01</span><h3>在线演示</h3><p>演示数据随站点发布，只用来说明阅读体验；它不代表网页会替你处理论文。</p><button type="button" onClick={() => openView("demo")}>开始体验</button></article>
          <article><span>02</span><h3>本地论文包</h3><p>推荐选择包含 article.md 与 images 的 Paper2MD / MinerU 结果目录，也支持单篇 Markdown 和安全受限的 ZIP。</p><button type="button" onClick={() => openView("local")}>打开 Reader</button></article>
          <article><span>03</span><h3>MinerU Token</h3><p>网页端永远不会索取或保存 Token。只有桌面端的可选 MinerU 流程需要用户自行配置。</p><a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">前往 MinerU Token 管理</a></article>
        </div>
      </section>

      <section className="site-privacy" aria-labelledby="privacy-title">
        <p className="site-kicker">隐私与数据边界</p>
        <h2 id="privacy-title">选择即授权，关闭即结束。</h2>
        <div>
          <p><b>不上传本地论文</b><span>目录、Markdown、ZIP 与图片在浏览器内读取。</span></p>
          <p><b>不收集 MinerU Token</b><span>网页没有 Token 输入、保存或转发功能。</span></p>
          <p><b>不常驻连接 localhost</b><span>网页端不长期控制桌面 Processing Service。</span></p>
          <p><b>源文件保持不可变</b><span>阅读修正只使用派生投影；契约冲突时安全关闭。</span></p>
        </div>
      </section>

      <footer className="site-footer">
        <a className="site-brand" href="#top">Paper2MD <span>Reader</span></a>
        <p>Local first. Cloud optional. Your paper stays yours.</p>
        <button type="button" onClick={() => openView("demo")}>在线体验 →</button>
      </footer>
    </main>
  );
}
