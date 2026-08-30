"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AfterMinerURepairReport,
  PortableMarkdownUnavailableReason,
  PortableMarkdownWarningCode,
  RepairProgress,
  RepairProgressStage,
  RepairReportWarningCode
} from "../../../packages/repair-core/src/index";
import { ProjectLinks } from "../project-links";
import {
  BrowserRepairCancelledError,
  runBrowserRepair,
  type BrowserRepairResult
} from "./repair-worker-client";

type RepairStatus = {
  tone: "working" | "error" | "ready" | "cancelled";
  message: string;
};

type PreparedExports = BrowserRepairResult;

// Keep the browser pre-read boundary aligned with repair-core's MinerU ZIP and source-PDF limits.
const MAX_REPAIR_INPUT_BYTES = 64 * 1024 * 1024;

const PROGRESS_LABELS: Record<RepairProgressStage, string> = {
  "inspect-source": "检查源 ZIP 与安全边界",
  "parse-content": "解析 Markdown、JSON 与源文件树",
  "analyze-visuals": "分析图表、图注与视觉候选",
  "materialize-derived": "物化派生 Markdown",
  "bind-package": "绑定 sidecar、来源与兼容契约",
  "verify-package": "校验 manifest、大小与 SHA-256",
  "build-portable-export": "检查通用 Markdown 资源闭包",
  "compress-portable-export": "压缩通用 Markdown ZIP",
  "compress-verified-package": "压缩可验证论文包",
  "compress-package": "压缩可验证论文包",
  complete: "修复与验证完成"
};

const WARNING_LABELS: Record<RepairReportWarningCode, string> = {
  "source-pdf-unavailable": "未绑定源 PDF，PDF 裁剪型显示修复不会启用",
  "review-candidates-present": "仍有需要人工复核的视觉候选",
  "unresolved-text-replacements": "派生正文仍含无法恢复的替换字符"
};

const PORTABLE_WARNING_LABELS: Record<PortableMarkdownWarningCode, string> = {
  "pdf-crop-not-materialized": "PDF 裁剪尚未物化为通用图片，ZIP 中保留完整源图片回退",
  "fragment-set-not-materialized": "碎图组合尚未物化为通用图片，ZIP 中保留完整源图片回退"
};

const PORTABLE_UNAVAILABLE_LABELS: Record<PortableMarkdownUnavailableReason, string> = {
  "reader-slots-not-materialized": "派生正文含 Reader 专用视觉 slot，尚不能安全降级为普通 Markdown 图片。",
  "unsupported-image-syntax": "正文含当前无法完整验证的图片语法。",
  "unsafe-asset-reference": "正文含不安全或无法规范化的图片路径。",
  "missing-source-asset": "正文引用的源图片不完整或无法唯一绑定。",
  "fallback-assets-incomplete": "Reader 投影所需的源图片回退不完整。",
  "portable-size-limit-exceeded": "通用 Markdown 资源闭包超过 64 MB 或 256 文件的安全上限；可验证论文包仍可下载。",
  "portable-archive-validation-failed": "通用 Markdown ZIP 未通过独立封装复验；可验证论文包仍可下载。"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function downloadBytes(bytes: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function downloadReport(report: AfterMinerURepairReport, archiveName: string): void {
  const filename = archiveName.replace(/\.after-mineru\.zip$/i, "") + ".repair-report.json";
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function inputSizeError(file: File, label: string): string | undefined {
  if (file.size < 1) return `${label}为空，未读取文件。`;
  if (file.size > MAX_REPAIR_INPUT_BYTES) return `${label}超过 64 MB 本地修复限制，未读取文件。`;
  return undefined;
}

export default function RepairPage() {
  const [mineruArchive, setMineruArchive] = useState<File | null>(null);
  const [sourcePdf, setSourcePdf] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedExports | null>(null);
  const [status, setStatus] = useState<RepairStatus | null>(null);
  const [progress, setProgress] = useState<RepairProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const archiveInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const activeRepair = useRef<AbortController | null>(null);
  const repairGeneration = useRef(0);

  useEffect(() => () => {
    repairGeneration.current += 1;
    activeRepair.current?.abort();
    activeRepair.current = null;
  }, []);

  const clearSession = () => {
    repairGeneration.current += 1;
    activeRepair.current?.abort();
    activeRepair.current = null;
    setMineruArchive(null);
    setSourcePdf(null);
    setPrepared(null);
    setStatus(null);
    setProgress(null);
    setBusy(false);
    if (archiveInput.current) archiveInput.current.value = "";
    if (pdfInput.current) pdfInput.current.value = "";
  };

  const runRepair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mineruArchive || busy) return;
    const archiveError = inputSizeError(mineruArchive, "MinerU ZIP");
    const pdfError = sourcePdf ? inputSizeError(sourcePdf, "源 PDF") : undefined;
    if (archiveError || pdfError) {
      setPrepared(null);
      setStatus({ tone: "error", message: archiveError ?? pdfError! });
      return;
    }
    const generation = repairGeneration.current + 1;
    repairGeneration.current = generation;
    const controller = new AbortController();
    activeRepair.current = controller;
    setBusy(true);
    setPrepared(null);
    setProgress({ stage: "inspect-source", percent: 0 });
    setStatus({ tone: "working", message: "正在专用 Worker 中修复 MinerU 结果并准备两种导出…" });
    try {
      const result = await runBrowserRepair({
        archive: mineruArchive,
        sourcePdf: sourcePdf ?? undefined
      }, {
        signal: controller.signal,
        onProgress(nextProgress) {
          if (repairGeneration.current !== generation) return;
          setProgress(nextProgress);
          setStatus({ tone: "working", message: PROGRESS_LABELS[nextProgress.stage] });
        }
      });
      if (repairGeneration.current !== generation) return;
      setPrepared(result);
      setProgress({ stage: "complete", percent: 100 });
      setStatus({
        tone: "ready",
        message: result.outputs.markdownZip.status === "ready"
          ? "修复完成：通用 Markdown ZIP 与可验证论文包均已准备。"
          : "修复完成：可验证论文包已准备；通用 Markdown 因资源闭包不完整而安全关闭。"
      });
    } catch (error) {
      if (repairGeneration.current !== generation) return;
      setPrepared(null);
      setProgress(null);
      setStatus(error instanceof BrowserRepairCancelledError
        ? { tone: "cancelled", message: error.message }
        : { tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (repairGeneration.current === generation) {
        activeRepair.current = null;
        setBusy(false);
      }
    }
  };

  const cancelRepair = () => {
    repairGeneration.current += 1;
    activeRepair.current?.abort();
    activeRepair.current = null;
    setBusy(false);
    setPrepared(null);
    setProgress(null);
    setStatus({ tone: "cancelled", message: "本次修复已取消；源文件未被修改，也没有保留半成品。" });
  };

  return (
    <main className="repair-page">
      <nav className="legal-nav repair-nav" aria-label="页面导航">
        <a className="site-brand" href="/">After‑<span>MinerU</span><small>Repair</small></a>
        <div className="repair-nav-links"><a href="/reader">打开 Reader</a><a href="/demo/debyecalculator">真实示例</a></div>
      </nav>

      <section className="repair-hero" aria-labelledby="repair-title">
        <div>
          <p className="site-eyebrow">PRODUCT A · LOCAL REPAIR WORKBENCH</p>
          <h1 id="repair-title">修复 MinerU 结果，<br />原始文件保持不变。</h1>
        </div>
        <div className="repair-hero-copy">
          <p>选择一个原始 MinerU ZIP，并可选加入你明确选择的源 PDF。Repair 会在当前浏览器会话中生成两种独立输出：供普通 Markdown 工具使用的通用 ZIP，以及供 Reader 验证的 After-MinerU 论文包。</p>
          <p><b>本地边界：</b>不上传到 Paper2MD，不建立云端论文库，不写 IndexedDB 或 localStorage；关闭页面或点击清除后，本页不再持有本次文件与结果。</p>
        </div>
      </section>

      <section className="repair-workspace" aria-label="After-MinerU Repair 工作区">
        <form className="repair-form" aria-busy={busy} onSubmit={(event) => void runRepair(event)}>
          <div className="repair-form-heading">
            <p className="site-kicker">输入</p>
            <h2>原始 MinerU ZIP</h2>
            <p>源 ZIP、其中的 Markdown、JSON、图片和 <code>_origin.pdf</code> 都会按原字节保留在可验证论文包的 <code>source/</code> 中。</p>
          </div>

          <label className="repair-file-field">
            <span><b>MinerU ZIP</b><small>必选 · .mineru.zip 或 .zip · ≤64 MB</small></span>
            <input
              ref={archiveInput}
              type="file"
              accept=".mineru.zip,.zip,application/zip"
              disabled={busy}
              required
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                const error = file ? inputSizeError(file, "MinerU ZIP") : undefined;
                setPrepared(null);
                if (error) {
                  setMineruArchive(null);
                  event.currentTarget.value = "";
                  setStatus({ tone: "error", message: error });
                } else {
                  setMineruArchive(file);
                  setStatus(null);
                }
              }}
            />
            <em>{mineruArchive ? `${mineruArchive.name} · ${formatBytes(mineruArchive.size)}` : "尚未选择"}</em>
          </label>

          <label className="repair-file-field optional">
            <span><b>源 PDF</b><small>可选 · 仅使用你明确选择的文件 · ≤64 MB</small></span>
            <input
              ref={pdfInput}
              type="file"
              accept=".pdf,application/pdf"
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                const error = file ? inputSizeError(file, "源 PDF") : undefined;
                setPrepared(null);
                if (error) {
                  setSourcePdf(null);
                  event.currentTarget.value = "";
                  setStatus({ tone: "error", message: error });
                } else {
                  setSourcePdf(file);
                  setStatus(null);
                }
              }}
            />
            <em>{sourcePdf ? `${sourcePdf.name} · ${formatBytes(sourcePdf.size)}` : "不额外加入；若 ZIP 有唯一 _origin.pdf，Repair 会绑定该副本"}</em>
          </label>

          <p className="repair-safety-note"><b>Fail closed：</b>ZIP 与可选 PDF 会在读取前执行 64 MB 大小边界；路径冲突、内容列表无效、哈希不匹配或修复无法事务性应用时，不会生成下载包，也不会覆盖任何本地源文件。通用 Markdown 的图片闭包会独立验证；无法形成安全、完整资源闭包时明确关闭，未物化的 Reader 视觉则只做源图片回退并提示。计算在一次性专用 Worker 中进行；接近上限的合法输入仍可能占用较多浏览器内存。</p>

          <div className="repair-actions">
            <button className="site-primary" type="submit" disabled={!mineruArchive || busy}>{busy ? "正在修复与验证…" : "修复并生成两种 ZIP"}</button>
            {busy
              ? <button className="site-secondary" type="button" onClick={cancelRepair}>取消本次修复</button>
              : <button className="site-secondary" type="button" onClick={clearSession} disabled={!mineruArchive && !sourcePdf && !prepared}>清除本次会话</button>}
          </div>
          {busy && progress ? (
            <div className="repair-progress" aria-label="修复进度">
              <span>{PROGRESS_LABELS[progress.stage]}</span><b>{progress.percent}%</b>
              <progress aria-label="修复进度百分比" max="100" value={progress.percent}>{progress.percent}%</progress>
            </div>
          ) : null}
          {status ? <p className={`repair-status ${status.tone}`} role="status">{status.message}</p> : null}
        </form>

        <aside className={`repair-output${prepared ? " ready" : ""}`}>
          <p className="site-kicker">输出</p>
          <h2>{prepared ? (prepared.outputs.markdownZip.status === "ready" ? "两种导出已准备" : "验证包已准备") : "等待本地输入"}</h2>
          {prepared ? (
            <>
              <dl>
                {prepared.outputs.markdownZip.status === "ready" ? (
                  <>
                    <div><dt>通用 Markdown</dt><dd>{prepared.outputs.markdownZip.name}</dd></div>
                    <div><dt>通用 ZIP</dt><dd>{formatBytes(prepared.outputs.markdownZip.bytes.byteLength)} · {prepared.outputs.markdownZip.fileCount} 个文件</dd></div>
                  </>
                ) : <div><dt>通用 Markdown</dt><dd>安全关闭</dd></div>}
                <div><dt>可验证论文包</dt><dd>{prepared.outputs.verifiedPackage.name}</dd></div>
                <div><dt>验证包</dt><dd>{formatBytes(prepared.outputs.verifiedPackage.bytes.byteLength)} · {prepared.outputs.verifiedPackage.fileCount} 个文件</dd></div>
                <div><dt>源图片</dt><dd>{prepared.summary.sourceImageCount}</dd></div>
                <div><dt>可见视觉项</dt><dd>{prepared.summary.visibleVisualCount}</dd></div>
                <div><dt>确定性修复</dt><dd>{prepared.summary.repairedVisualCount}</dd></div>
                <div><dt>待复核候选</dt><dd>{prepared.summary.reviewCandidateCount}</dd></div>
              </dl>
              <p className="repair-hash"><b>源 ZIP SHA-256</b><code>{prepared.sourceSha256}</code><span>{prepared.algorithmVersion}</span></p>
              <div className="repair-report-summary">
                <b>修复报告</b>
                {prepared.report.warnings.length > 0
                  ? <ul>{prepared.report.warnings.map((warning) => (
                    <li key={warning.code}>{WARNING_LABELS[warning.code]}{warning.count > 1 ? `（${warning.count}）` : ""}</li>
                  ))}</ul>
                  : <p>未发现需要提示的剩余项。</p>}
              </div>
              <div className="repair-report-summary">
                <b>通用 Markdown 边界</b>
                {prepared.outputs.markdownZip.status === "ready" ? (
                  prepared.outputs.markdownZip.warnings.length > 0
                    ? <ul>{prepared.outputs.markdownZip.warnings.map((warning) => (
                      <li key={warning.code}>{PORTABLE_WARNING_LABELS[warning.code]}{warning.count > 1 ? `（${warning.count}）` : ""}</li>
                    ))}</ul>
                    : <p>正文与全部本地图片已形成可验证的普通 Markdown 资源闭包。</p>
                ) : <p>{PORTABLE_UNAVAILABLE_LABELS[prepared.outputs.markdownZip.reason]}</p>}
              </div>
              <div className="repair-download-actions">
                {prepared.outputs.markdownZip.status === "ready" ? (
                  <button className="site-primary" type="button" onClick={() => {
                    const output = prepared.outputs.markdownZip;
                    if (output.status === "ready") downloadBytes(output.bytes, output.name);
                  }}>下载通用 Markdown ZIP</button>
                ) : null}
                <button className="site-secondary" type="button" onClick={() => downloadBytes(prepared.outputs.verifiedPackage.bytes, prepared.outputs.verifiedPackage.name)}>下载可验证论文包</button>
                <button className="site-secondary" type="button" onClick={() => downloadReport(prepared.report, prepared.outputs.verifiedPackage.name)}>下载报告 JSON</button>
              </div>
            </>
          ) : (
            <ul>
              <li>通用 ZIP 只含派生 Markdown、完整图片闭包与导出记录</li>
              <li><code>source/</code> 保留原始 MinerU 内容</li>
              <li><code>derived/article.after-mineru.md</code> 保存派生正文</li>
              <li><code>sidecars/</code> 保存投影、修复与验证证据</li>
              <li><code>after-mineru.manifest.json</code> 绑定全部哈希</li>
            </ul>
          )}
        </aside>
      </section>

      <section className="repair-contract" aria-labelledby="repair-contract-title">
        <div><p className="site-kicker">互操作边界</p><h2 id="repair-contract-title">Repair 生成；Reader 只验证并呈现。</h2></div>
        <div><p>通用 Markdown ZIP 保留可验证的普通图片资源闭包；Reader 专用的双栏、PDF 裁剪和交互投影只存在于可验证论文包中。未物化的视觉投影会明确标记源图片回退，绝不冒充或覆盖 MinerU 的 <code>full.md</code>。</p><a href="/reader">打开独立 Reader <span aria-hidden="true">→</span></a></div>
      </section>

      <footer className="legal-footer repair-footer"><a href="/">返回 After‑MinerU 首页</a><ProjectLinks includeDemo /></footer>
    </main>
  );
}
