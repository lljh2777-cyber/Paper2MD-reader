"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AfterMinerURepairReport,
  RepairMinerUArchiveSummary,
  RepairProgress,
  RepairProgressStage,
  RepairReportWarningCode
} from "../../../packages/repair-core/src/index";
import { ProjectLinks } from "../project-links";
import {
  BrowserRepairCancelledError,
  runBrowserRepair
} from "./repair-worker-client";

type RepairStatus = {
  tone: "working" | "error" | "ready" | "cancelled";
  message: string;
};

type PreparedPackage = {
  algorithmVersion: string;
  archiveName: string;
  bytes: Uint8Array;
  fileCount: number;
  report: AfterMinerURepairReport;
  sourceSha256: string;
  summary: RepairMinerUArchiveSummary;
};

// Keep the browser pre-read boundary aligned with repair-core's MinerU ZIP and source-PDF limits.
const MAX_REPAIR_INPUT_BYTES = 64 * 1024 * 1024;

const PROGRESS_LABELS: Record<RepairProgressStage, string> = {
  "inspect-source": "检查源 ZIP 与安全边界",
  "parse-content": "解析 Markdown、JSON 与源文件树",
  "analyze-visuals": "分析图表、图注与视觉候选",
  "materialize-derived": "物化派生 Markdown",
  "bind-package": "绑定 sidecar、来源与兼容契约",
  "verify-package": "校验 manifest、大小与 SHA-256",
  "compress-package": "压缩可验证论文包",
  complete: "修复与验证完成"
};

const WARNING_LABELS: Record<RepairReportWarningCode, string> = {
  "source-pdf-unavailable": "未绑定源 PDF，PDF 裁剪型显示修复不会启用",
  "review-candidates-present": "仍有需要人工复核的视觉候选",
  "unresolved-text-replacements": "派生正文仍含无法恢复的替换字符"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
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
  const [prepared, setPrepared] = useState<PreparedPackage | null>(null);
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
    setStatus({ tone: "working", message: "正在专用 Worker 中校验 MinerU ZIP 并生成派生论文包…" });
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
      setPrepared({
        algorithmVersion: result.algorithmVersion,
        archiveName: result.archiveName,
        bytes: new Uint8Array(result.archiveBytes),
        fileCount: result.fileCount,
        report: result.report,
        sourceSha256: result.sourceSha256,
        summary: result.summary
      });
      setProgress({ stage: "complete", percent: 100 });
      setStatus({
        tone: "ready",
        message: "修复完成：manifest、修复报告、文件大小与 SHA-256 已重新验证，可下载独立论文包。"
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
          <p>选择一个原始 MinerU ZIP，并可选加入你明确选择的源 PDF。Repair 会在当前浏览器会话中生成派生 Markdown、sidecar、manifest 与 validation，再导出可验证论文包。</p>
          <p><b>本地边界：</b>不上传到 Paper2MD，不建立云端论文库，不写 IndexedDB 或 localStorage；关闭页面或点击清除后，本页不再持有本次文件与结果。</p>
        </div>
      </section>

      <section className="repair-workspace" aria-label="After-MinerU Repair 工作区">
        <form className="repair-form" aria-busy={busy} onSubmit={(event) => void runRepair(event)}>
          <div className="repair-form-heading">
            <p className="site-kicker">输入</p>
            <h2>原始 MinerU ZIP</h2>
            <p>源 ZIP、其中的 Markdown、JSON、图片和 <code>_origin.pdf</code> 都会按原字节保留在输出包的 <code>source/</code> 中。</p>
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

          <p className="repair-safety-note"><b>Fail closed：</b>ZIP 与可选 PDF 会在读取前执行 64 MB 大小边界；路径冲突、内容列表无效、哈希不匹配或修复无法事务性应用时，不会生成下载包，也不会覆盖任何本地源文件。计算在一次性专用 Worker 中进行；接近上限的合法输入仍可能占用较多浏览器内存。</p>

          <div className="repair-actions">
            <button className="site-primary" type="submit" disabled={!mineruArchive || busy}>{busy ? "正在修复与验证…" : "生成可验证论文包"}</button>
            {busy
              ? <button className="site-secondary" type="button" onClick={cancelRepair}>取消本次修复</button>
              : <button className="site-secondary" type="button" onClick={clearSession} disabled={!mineruArchive && !sourcePdf && !prepared}>清除本次会话</button>}
          </div>
          {busy && progress ? (
            <div className="repair-progress" aria-label="修复进度">
              <span>{PROGRESS_LABELS[progress.stage]}</span><b>{progress.percent}%</b>
              <progress max="100" value={progress.percent}>{progress.percent}%</progress>
            </div>
          ) : null}
          {status ? <p className={`repair-status ${status.tone}`} role="status">{status.message}</p> : null}
        </form>

        <aside className={`repair-output${prepared ? " ready" : ""}`} aria-live="polite">
          <p className="site-kicker">输出</p>
          <h2>{prepared ? "验证通过" : "等待本地输入"}</h2>
          {prepared ? (
            <>
              <dl>
                <div><dt>文件</dt><dd>{prepared.archiveName}</dd></div>
                <div><dt>包大小</dt><dd>{formatBytes(prepared.bytes.byteLength)}</dd></div>
                <div><dt>包内文件</dt><dd>{prepared.fileCount}</dd></div>
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
              <div className="repair-download-actions">
                <button className="site-primary" type="button" onClick={() => downloadBytes(prepared.bytes, prepared.archiveName)}>下载可验证包</button>
                <button className="site-secondary" type="button" onClick={() => downloadReport(prepared.report, prepared.archiveName)}>下载报告 JSON</button>
              </div>
            </>
          ) : (
            <ul>
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
        <div><p>通用 Markdown 无法承载 Reader 的双栏、PDF 裁剪和交互投影，因此本入口当前导出的是可验证 After-MinerU 包。显示层不会冒充或覆盖 MinerU 的 <code>full.md</code>。</p><a href="/reader">打开独立 Reader <span aria-hidden="true">→</span></a></div>
      </section>

      <footer className="legal-footer repair-footer"><a href="/">返回 After‑MinerU 首页</a><ProjectLinks includeDemo /></footer>
    </main>
  );
}
