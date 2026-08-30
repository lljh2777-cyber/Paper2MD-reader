"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  DEBYE_CALCULATOR_DEMO,
  loadStaticMinerUDemo,
  type LoadedStaticMinerUDemo
} from "../../../lib/static-mineru-demo";
import { renderLocalArticle } from "../../../../src/render/local-article-renderer";
import {
  MINERU_PROJECT_URL,
  PROJECT_REPOSITORY_URL,
  ProjectLinks
} from "../../project-links";

type DemoStage = "source" | "mineru" | "repaired";
type RawView = "preview" | "source";

const STAGES: ReadonlyArray<{ id: DemoStage; number: string; label: string; detail: string }> = [
  { id: "source", number: "01", label: "原始 PDF", detail: "上传前的 JOSS 原文" },
  { id: "mineru", number: "02", label: "MinerU 原始结果", detail: "未经修复的 Markdown / ZIP" },
  { id: "repaired", number: "03", label: "After‑MinerU Reader", detail: "哈希绑定的派生阅读投影" }
];

const RAW_VIEWS: ReadonlyArray<{ id: RawView; label: string }> = [
  { id: "preview", label: "Markdown 预览" },
  { id: "source", label: "原始源码" }
];

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function focusRawFragments(
  container: HTMLElement,
  assetPaths: readonly string[],
  options: { focus?: boolean; isCurrent?: () => boolean } = {}
): Promise<boolean> {
  container.querySelectorAll<HTMLElement>(".demo-raw-fragment").forEach((element) => {
    element.classList.remove("demo-raw-fragment");
    element.removeAttribute("data-fragment-number");
    element.removeAttribute("aria-label");
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
  });
  const images = [...container.querySelectorAll<HTMLImageElement>("img[data-p2md-source-path]")];
  const targets = assetPaths.map((path) => {
    const matches = images.filter((image) => image.dataset.p2mdSourcePath === path);
    return matches.length === 1 ? matches[0] : undefined;
  });
  if (targets.some((image) => !image)) return false;
  images.forEach((image) => { image.loading = "eager"; });
  await Promise.race([
    Promise.all(images.map((image) => image.decode().catch(() => undefined))),
    new Promise<void>((resolve) => setTimeout(resolve, 4_000))
  ]);
  if (options.isCurrent && !options.isCurrent()) return false;
  targets.forEach((image, index) => {
    const target = image!.closest<HTMLElement>("p") ?? image!;
    target.classList.add("demo-raw-fragment");
    target.dataset.fragmentNumber = String(index + 1);
    target.setAttribute("role", "group");
    target.setAttribute("aria-label", `MinerU 碎图 ${index + 1} / ${targets.length}`);
  });
  const first = (targets[0]!.closest<HTMLElement>("p") ?? targets[0]!);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const containerTop = container.getBoundingClientRect().top;
  const targetTop = first.getBoundingClientRect().top;
  container.scrollTop = Math.max(0, container.scrollTop + targetTop - containerTop - 96);
  if (options.focus) {
    first.tabIndex = -1;
    first.focus({ preventScroll: true });
  }
  return true;
}

export default function DebyeCalculatorDemoPage() {
  const [stage, setStage] = useState<DemoStage>("source");
  const [rawView, setRawView] = useState<RawView>("preview");
  const [demo, setDemo] = useState<LoadedStaticMinerUDemo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [rawPreviewError, setRawPreviewError] = useState<string | null>(null);
  const [rawFocusStatus, setRawFocusStatus] = useState("");
  const readerRoot = useRef<HTMLDivElement>(null);
  const rawPreviewRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void loadStaticMinerUDemo(controller.signal)
      .then((value) => {
        if (!cancelled) setDemo(value);
      })
      .catch((reason: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (stage !== "repaired" || !demo || !readerRoot.current) return;
    let cancelled = false;
    let mounted: { ready: Promise<void>; dispose(): void } | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      mounted?.dispose();
    };
    setReaderError(null);
    void import("../../../../local-reader/main")
      .then(async ({ mountLocalReaderWithReady }) => {
        if (cancelled || !readerRoot.current) return;
        const fileSystem = demo.createReaderFileSystem();
        try {
          mounted = mountLocalReaderWithReady(readerRoot.current, {
            initialFileSystem: fileSystem,
            capabilityProfile: "strict-readonly",
            visualReviewMode: "disabled",
            allowPdfProjection: false,
            allowDirectPdfOpen: true,
            allowRuntimeTextRecovery: false,
            enableWebMcp: false,
            enableProcessingApi: false,
            persistPaperState: false
          });
        } catch (reason) {
          fileSystem.dispose();
          throw reason;
        }
        await mounted.ready;
        if (cancelled) release();
      })
      .catch((reason: unknown) => {
        release();
        if (!cancelled) setReaderError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [demo, stage]);

  useEffect(() => {
    if (stage !== "mineru" || rawView !== "preview" || !demo || !rawPreviewRoot.current) return;
    let cancelled = false;
    let finished = false;
    let retainFileSystem = false;
    let disposed = false;
    const root = rawPreviewRoot.current;
    const staging = document.createElement("div");
    const fileSystem = demo.createRawPreviewFileSystem();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      fileSystem.dispose();
    };
    root.replaceChildren();
    setRawPreviewError(null);
    const renderTask = import("katex/dist/katex.min.css")
      .then(() => renderLocalArticle(demo.rawMarkdown, staging, fileSystem, false))
      .then(async () => {
        if (cancelled) return;
        root.replaceChildren(...staging.childNodes);
        const focused = await focusRawFragments(root, demo.rawFocusAssetPaths, {
          isCurrent: () => !cancelled
        });
        if (!cancelled && focused) setRawFocusStatus("已定位到 MinerU 碎图 1 / 4，共 4 张。");
        if (!cancelled && !focused) setRawPreviewError("四张碎图的原始 Markdown 锚点未能唯一定位；已停止自动跳转。");
        if (!cancelled) retainFileSystem = true;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setRawPreviewError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        finished = true;
        if (cancelled || !retainFileSystem) dispose();
      });
    return () => {
      cancelled = true;
      root.replaceChildren();
      if (finished) dispose();
      else void renderTask.finally(dispose);
    };
  }, [demo, rawView, stage]);

  const selectStage = (nextStage: DemoStage) => {
    setReaderError(null);
    setRawPreviewError(null);
    setRawFocusStatus("");
    if (nextStage === "mineru") setRawView("preview");
    setStage(nextStage);
  };

  const moveStageFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentStage: DemoStage) => {
    const current = STAGES.findIndex((item) => item.id === currentStage);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % STAGES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + STAGES.length) % STAGES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = STAGES.length - 1;
    else return;
    event.preventDefault();
    const nextStage = STAGES[next];
    selectStage(nextStage.id);
    requestAnimationFrame(() => document.getElementById(`demo-tab-${nextStage.id}`)?.focus());
  };

  const selectRawView = (nextView: RawView) => {
    setRawPreviewError(null);
    setRawFocusStatus("");
    setRawView(nextView);
  };

  const moveRawViewFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentView: RawView) => {
    const current = RAW_VIEWS.findIndex((item) => item.id === currentView);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % RAW_VIEWS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + RAW_VIEWS.length) % RAW_VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = RAW_VIEWS.length - 1;
    else return;
    event.preventDefault();
    const nextView = RAW_VIEWS[next];
    selectRawView(nextView.id);
    requestAnimationFrame(() => document.getElementById(`demo-raw-tab-${nextView.id}`)?.focus());
  };

  return (
    <main className="demo-page">
      <header className="demo-nav">
        <a className="site-brand" href="/" aria-label="返回 After-MinerU 首页">After‑<span>MinerU</span><small>by Paper2MD</small></a>
        <a href="/">← 返回工作台</a>
      </header>

      <section className="demo-hero" aria-labelledby="demo-title">
        <div>
          <p className="site-eyebrow">REAL PAPER · CC BY 4.0 · 6 PAGES</p>
          <h1 id="demo-title">同一篇真实论文，<br />看清转换前后。</h1>
        </div>
        <div className="demo-hero-copy">
          <p>{DEBYE_CALCULATOR_DEMO.shortTitle}</p>
          <span>{DEBYE_CALCULATOR_DEMO.citation}</span>
          <p>这是随站点公开发布的固定示例，不是用户论文。页面只读取同源示例资产；你的本地文件仍不会进入 After‑MinerU 云端论文库。</p>
        </div>
      </section>

      <nav className="demo-stage-tabs" role="tablist" aria-label="论文处理阶段">
        {STAGES.map((item) => (
          <button
            key={item.id}
            id={`demo-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={stage === item.id}
            aria-controls={`demo-panel-${item.id}`}
            tabIndex={stage === item.id ? 0 : -1}
            onClick={() => selectStage(item.id)}
            onKeyDown={(event) => moveStageFocus(event, item.id)}
          >
            <span>{item.number}</span><b>{item.label}</b><small>{item.detail}</small>
          </button>
        ))}
      </nav>

      {error ? (
        <section className="demo-load-error" role="alert">
          <p className="site-kicker">FAIL CLOSED</p>
          <h2>示例未通过完整性校验。</h2>
          <p>{error}</p>
          <button type="button" className="site-primary" onClick={() => window.location.reload()}>重新校验</button>
        </section>
      ) : !demo ? (
        <section className="demo-loading" aria-live="polite">
          <span aria-hidden="true"></span><b>正在校验原 PDF、MinerU ZIP 与派生契约…</b>
          <p>只有大小、SHA‑256、ZIP 结构和 Reader 契约全部通过后，修复视图才会启用。</p>
        </section>
      ) : (
        <section className="demo-stage-shell">
          {stage === "source" ? (
            <div id="demo-panel-source" role="tabpanel" aria-labelledby="demo-tab-source" className="demo-source-stage">
              <figure>
                <img src={DEBYE_CALCULATOR_DEMO.sourcePreview.path} alt="DebyeCalculator JOSS 论文原 PDF 第一页" />
                <figcaption>原 PDF 第 1 页的静态预览；点击右侧链接打开完整原文件。</figcaption>
              </figure>
              <article>
                <p className="site-kicker">上传前原文件</p>
                <h2>{DEBYE_CALCULATOR_DEMO.title}</h2>
                <p>{DEBYE_CALCULATOR_DEMO.authors}</p>
                <dl>
                  <div><dt>来源</dt><dd>Journal of Open Source Software</dd></div>
                  <div><dt>许可</dt><dd>CC BY 4.0</dd></div>
                  <div><dt>大小</dt><dd>{megabytes(DEBYE_CALCULATOR_DEMO.sourcePdf.size)}</dd></div>
                  <div><dt>SHA‑256</dt><dd><code>{DEBYE_CALCULATOR_DEMO.sourcePdf.sha256}</code></dd></div>
                </dl>
                <div className="demo-actions">
                  <a className="site-primary" href={DEBYE_CALCULATOR_DEMO.sourcePdf.path} target="_blank" rel="noreferrer">打开完整原 PDF</a>
                  <a href={DEBYE_CALCULATOR_DEMO.articleUrl} target="_blank" rel="noreferrer">查看 JOSS 原文</a>
                </div>
                <p className="demo-integrity-note"><b>独立保留：</b>MinerU ZIP 内的 <code>_origin.pdf</code> 是 MinerU 返回件，和这份上传前原 PDF 的字节不同；两者均未被改写，也不会混为同一文件。</p>
              </article>
            </div>
          ) : null}

          {stage === "mineru" ? (
            <div id="demo-panel-mineru" role="tabpanel" aria-labelledby="demo-tab-mineru" className="demo-raw-stage">
              <header>
                <div><p className="site-kicker">MINERU VLM · 原始输出</p><h2>忠实展示，不替它纠错。</h2></div>
                <div className="demo-stats" aria-label="MinerU 输出统计"><span><b>{demo.stats.pages}</b> 页</span><span><b>{demo.stats.json}</b> JSON</span><span><b>{demo.stats.images}</b> 原图</span><span><b>{demo.stats.files}</b> 文件</span></div>
              </header>
              <p className="demo-warning">这是 MinerU 输出的原始 Markdown 预览。页面已定位到 Figure 3 被拆分的四张图片，便于与 After-MinerU 修复后的阅读效果对比；切换“原始源码”可查看原始文本。</p>
              <div className="demo-raw-toolbar">
                <div role="tablist" aria-label="MinerU 原始结果视图">
                  {RAW_VIEWS.map((item) => (
                    <button
                      key={item.id}
                      id={`demo-raw-tab-${item.id}`}
                      type="button"
                      role="tab"
                      aria-selected={rawView === item.id}
                      aria-controls={`demo-raw-panel-${item.id}`}
                      tabIndex={rawView === item.id ? 0 : -1}
                      onClick={() => selectRawView(item.id)}
                      onKeyDown={(event) => moveRawViewFocus(event, item.id)}
                    >{item.label}</button>
                  ))}
                </div>
                {rawView === "preview" ? <button type="button" onClick={() => {
                  if (!rawPreviewRoot.current) return;
                  setRawFocusStatus("");
                  void focusRawFragments(rawPreviewRoot.current, demo.rawFocusAssetPaths, { focus: true }).then((focused) => {
                    if (focused) setRawFocusStatus("已定位到 MinerU 碎图 1 / 4，共 4 张。");
                    else setRawPreviewError("四张碎图的原始 Markdown 锚点未能唯一定位；已停止自动跳转。");
                  });
                }}>回到四张碎图</button> : null}
              </div>
              <p className="site-sr-only" role="status" aria-live="polite">{rawFocusStatus}</p>
              {rawPreviewError ? <p className="demo-raw-error" role="alert">{rawPreviewError}</p> : null}
              {rawView === "preview"
                ? <div id="demo-raw-panel-preview" ref={rawPreviewRoot} className="demo-raw-preview p2md-article markdown-rendered" tabIndex={0} role="tabpanel" aria-labelledby="demo-raw-tab-preview" />
                : <pre id="demo-raw-panel-source" tabIndex={0} role="tabpanel" aria-labelledby="demo-raw-tab-source">{demo.rawMarkdown}</pre>}
              <div className="demo-actions">
                <a className="site-primary" href={DEBYE_CALCULATOR_DEMO.rawArchive.path} download>下载原始 MinerU ZIP</a>
                <span>{megabytes(DEBYE_CALCULATOR_DEMO.rawArchive.size)} · SHA‑256 {DEBYE_CALCULATOR_DEMO.rawArchive.sha256.slice(0, 16)}…</span>
              </div>
            </div>
          ) : null}

          {stage === "repaired" ? (
            <div id="demo-panel-repaired" role="tabpanel" aria-labelledby="demo-tab-repaired" className="demo-repaired-stage">
              <header className="demo-repair-summary">
                <div><p className="site-kicker">DERIVED PROJECTION · 源文件未改</p><h2>四块碎图被确定性合并为 1 个 Figure 3 阅读视图。</h2></div>
                <ul><li>完整性：manifest 与 SHA‑256 已核验</li><li>视觉修复：{demo.stats.repairedGroups} 组 / {demo.stats.groupedFragments} 个原图碎片</li><li>文字修复：{demo.stats.articleRepairs} 处正文 + {demo.stats.captionRepairs} 条图注 / {demo.stats.replacementCharactersRecovered} 个乱码替换字符</li><li>冲突策略：证据不足即保留 MinerU 原图</li></ul>
              </header>
              <p className="demo-warning">Reader 展示的是派生 Markdown 与视觉投影，不会回写原始 <code>{demo.articlePath}</code>。两处正文和 Figure 2、Figure 3 图注只在源 PDF、原文哈希、区块 ID 与原始文字全部精确匹配时恢复；其他识别或拼写错误仍保留，便于对照。</p>
              {readerError ? <div className="demo-reader-error" role="alert">Reader 未能启动：{readerError}</div> : <div ref={readerRoot} className="demo-reader-mount" aria-label="After-MinerU 派生 Reader" />}
              <div className="demo-actions demo-package-actions">
                <a className="site-primary" href={DEBYE_CALCULATOR_DEMO.verifiedPackage.path} download={DEBYE_CALCULATOR_DEMO.verifiedPackage.downloadName}>下载 formal v1 可验证论文包</a>
                <a href={DEBYE_CALCULATOR_DEMO.legacyPackage.path} download={DEBYE_CALCULATOR_DEMO.legacyPackage.downloadName}>下载 v0.1.3 兼容包</a>
                <span>formal v1 包含不可变原 PDF、原 MinerU ZIP/输出、派生 Markdown 与哈希绑定 sidecar；不把显示投影冒充源 Markdown。</span>
              </div>
            </div>
          ) : null}
        </section>
      )}

      <section className="demo-license" aria-labelledby="demo-license-title">
        <div><p className="site-kicker">来源与许可</p><h2 id="demo-license-title">真实论文，可以公开演示，也必须正确署名。</h2></div>
        <div>
          <p>本示例基于 {DEBYE_CALCULATOR_DEMO.authors}，<em>{DEBYE_CALCULATOR_DEMO.title}</em>，{DEBYE_CALCULATOR_DEMO.citation}。版权归作者所有；原作依 <a href={DEBYE_CALCULATOR_DEMO.licenseUrl} target="_blank" rel="noreferrer">CC BY 4.0</a> 许可提供。</p>
          <p>After‑MinerU 只增加自动解析、图像索引、确定性图注/视觉修复与 Reader 投影。自动结果可能有误；本演示与原作者、JOSS、The Open Journal、MinerU 或 OpenDataLab 不存在隶属、赞助或背书关系。</p>
          <div className="demo-actions"><a href={DEBYE_CALCULATOR_DEMO.doiUrl} target="_blank" rel="noreferrer">DOI 10.21105/joss.06024</a><a href={`${DEBYE_CALCULATOR_DEMO.rawArchive.path.replace("mineru-original.mineru.zip", "ATTRIBUTION.md")}`} target="_blank" rel="noreferrer">完整署名与变更说明</a><a href={MINERU_PROJECT_URL} target="_blank" rel="noreferrer">MinerU 官方项目</a><a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer">After-MinerU 源代码</a></div>
        </div>
      </section>
      <footer className="legal-footer demo-footer"><a href="/">返回 After‑MinerU</a><ProjectLinks /></footer>
    </main>
  );
}
