import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import {
  recoverPdfCaptionContinuation,
  suppressRecoveredCaptionContinuation
} from "../../../src/model/mineru-caption-recovery";
import { Diagnostic, LoadedAsset, LoadedPaperPackage, NormalizedBBox } from "../../../src/model/reader-contract";
import type { PdfPageRenderResult, PdfReferenceRuntime } from "../../../src/render/pdf-reference-pane";
import {
  applyRecoveredParagraph,
  applyRecoveredText,
  recoverMinerUParagraph,
  recoverReplacementCharacters
} from "../../../src/model/mineru-text-recovery";

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PDF crop canvas could not be encoded")), "image/png");
  });
}

function padded(bbox: NormalizedBBox, padding: number): NormalizedBBox {
  const x = Math.max(0, bbox.x - padding);
  const y = Math.max(0, bbox.y - padding);
  const right = Math.min(1, bbox.x + bbox.width + padding);
  const bottom = Math.min(1, bbox.y + bbox.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Fragment image could not be decoded")), { once: true });
    image.src = url;
  });
}

interface CancellablePdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export class PdfVisualResolver implements PdfReferenceRuntime {
  private fileSystem?: ReaderFileSystem;
  private pdfPath?: string;
  private documentPromise?: Promise<PDFDocumentProxy>;
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private readonly urls = new Set<string>();
  private readonly pageTasks = new Set<CancellablePdfRenderTask>();
  private pageGeneration = 0;

  async open(fileSystem: ReaderFileSystem, pdfPath: string): Promise<number> {
    return (await this.loadDocument(fileSystem, pdfPath)).numPages;
  }

  async renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    availableWidth: number,
    zoom: number
  ): Promise<PdfPageRenderResult> {
    const document = this.document ?? await this.documentPromise;
    if (!document) throw new Error("PDF is not loaded");
    const generation = this.pageGeneration;
    const page = await document.getPage(Math.max(1, Math.min(document.numPages, pageNumber)));
    if (generation !== this.pageGeneration) throw new DOMException("PDF page render superseded", "AbortError");
    const base = page.getViewport({ scale: 1 });
    const fitScale = Math.max(0.25, availableWidth / Math.max(1, base.width));
    const viewport = page.getViewport({ scale: fitScale * Math.max(0.4, Math.min(4, zoom)) });
    const outputScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas is unavailable");
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      background: "#ffffff"
    }) as CancellablePdfRenderTask;
    this.pageTasks.add(task);
    try {
      await task.promise;
    } finally {
      this.pageTasks.delete(task);
    }
    if (generation !== this.pageGeneration) throw new DOMException("PDF page render superseded", "AbortError");
    return { width: viewport.width, height: viewport.height };
  }

  cancelPageRender(): void {
    this.pageGeneration += 1;
    for (const task of this.pageTasks) {
      try {
        task.cancel();
      } catch {
        // PDF.js may reject cancellation after a task has just completed.
      }
    }
    this.pageTasks.clear();
  }

  async resolve(asset: LoadedAsset, fileSystem: ReaderFileSystem): Promise<string> {
    if (asset.display?.mode === "fragment-set") {
      try {
        const fragments = asset.display.fragments;
        if (fragments.length < 2) return fileSystem.resolveAssetUrl(asset.path);
        const left = Math.min(...fragments.map((fragment) => fragment.bbox.x));
        const top = Math.min(...fragments.map((fragment) => fragment.bbox.y));
        const right = Math.max(...fragments.map((fragment) => fragment.bbox.x + fragment.bbox.width));
        const bottom = Math.max(...fragments.map((fragment) => fragment.bbox.y + fragment.bbox.height));
        const unionWidth = right - left;
        const unionHeight = bottom - top;
        if (unionWidth <= 0 || unionHeight <= 0) throw new Error("Fragment layout has an invalid union box");
        const width = 1600;
        const height = Math.max(1, Math.min(2400, Math.round(width * unionHeight / unionWidth)));
        const canvas = window.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        const images = await Promise.all(fragments.map(async (fragment) => {
          const url = await fileSystem.resolveAssetUrl(fragment.path);
          return { fragment, image: await loadImage(url) };
        }));
        images.forEach(({ fragment, image }) => {
          context.drawImage(
            image,
            Math.round((fragment.bbox.x - left) / unionWidth * width),
            Math.round((fragment.bbox.y - top) / unionHeight * height),
            Math.max(1, Math.round(fragment.bbox.width / unionWidth * width)),
            Math.max(1, Math.round(fragment.bbox.height / unionHeight * height))
          );
        });
        const url = URL.createObjectURL(await canvasBlob(canvas));
        this.urls.add(url);
        return url;
      } catch (error) {
        console.warn("Fragment-set reconstruction failed; using the first packaged asset", error);
        return fileSystem.resolveAssetUrl(asset.path);
      }
    }
    if (asset.display?.mode !== "pdf-crop") return fileSystem.resolveAssetUrl(asset.path);
    try {
      const document = await this.loadDocument(fileSystem, asset.display.pdfPath);
      const page = await document.getPage(Math.max(1, Math.min(document.numPages, (asset.pageIndex ?? 0) + 1)));
      const base = page.getViewport({ scale: 1 });
      const crop = padded(asset.display.bbox, asset.display.padding);
      const cropWidth = Math.max(1, base.width * crop.width);
      const scale = Math.max(0.75, Math.min(4, 1600 / cropWidth));
      const viewport = page.getViewport({ scale });
      const left = viewport.width * crop.x;
      const top = viewport.height * crop.y;
      const width = Math.max(1, viewport.width * crop.width);
      const height = Math.max(1, viewport.height * crop.height);
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(width);
      canvas.height = Math.ceil(height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable");
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -left, -top],
        background: "#ffffff"
      }).promise;
      page.cleanup();
      const url = URL.createObjectURL(await canvasBlob(canvas));
      this.urls.add(url);
      return url;
    } catch (error) {
      console.warn("PDF crop reconstruction failed; using the packaged MinerU asset", error);
      return fileSystem.resolveAssetUrl(asset.path);
    }
  }

  async recoverText(
    articleText: string,
    recovery: NonNullable<LoadedPaperPackage["textRecovery"]>,
    fileSystem: ReaderFileSystem
  ): Promise<{
    articleText: string;
    diagnostics: Diagnostic[];
    captionUpdates: Array<{ visualId: string; captionText: string; captionStatus: "complete" | "partial" }>;
  }> {
    const diagnostics: Diagnostic[] = [];
    const captionUpdates: Array<{ visualId: string; captionText: string; captionStatus: "complete" | "partial" }> = [];
    let projected = articleText;
    let recoveredCount = 0;
    let recoveredCaptionCount = 0;
    let recoveredParagraphCount = 0;
    try {
      const document = await this.loadDocument(fileSystem, recovery.pdfPath);
      const pageCache = new Map<number, Promise<{
        viewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>;
        items: Array<{ text: string; x: number; centerY: number; width: number }>;
      }>>();
      const pageData = async (pageIndex: number) => {
        const pageNumber = Math.max(1, Math.min(document.numPages, pageIndex + 1));
        if (!pageCache.has(pageNumber)) {
          pageCache.set(pageNumber, document.getPage(pageNumber).then(async (page) => {
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const items = content.items.flatMap((item) => {
              if (!("str" in item) || !("transform" in item) || !("width" in item) || !("height" in item)) return [];
              const textItem = item as { str: string; transform: number[]; width: number; height: number };
              const [x, baseline] = viewport.convertToViewportPoint(textItem.transform[4], textItem.transform[5]);
              return [{ text: textItem.str, x, centerY: baseline - Math.abs(textItem.height) / 2, width: textItem.width }];
            });
            return { viewport, items };
          }));
        }
        return { pageNumber, ...await pageCache.get(pageNumber)! };
      };
      const textInBbox = (
        viewport: Awaited<ReturnType<typeof pageData>>["viewport"],
        items: Awaited<ReturnType<typeof pageData>>["items"],
        bbox: NormalizedBBox
      ) => {
        const padding = 0.015;
        const left = Math.max(0, bbox.x - padding) * viewport.width;
        const right = Math.min(1, bbox.x + bbox.width + padding) * viewport.width;
        const top = Math.max(0, bbox.y - padding) * viewport.height;
        const bottom = Math.min(1, bbox.y + bbox.height + padding) * viewport.height;
        return items
          .filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 <= right && item.centerY >= top && item.centerY <= bottom)
          .map((item) => item.text)
          .join(" ");
      };
      for (const candidate of recovery.candidates) {
        const { viewport, items } = await pageData(candidate.pageIndex);
        const blockText = textInBbox(viewport, items, candidate.bbox);
        const pageText = items.map((item) => item.text).join(" ");
        const recovered = recoverReplacementCharacters(candidate.sourceText, blockText)
          ?? recoverReplacementCharacters(candidate.sourceText, pageText);
        const next = recovered ? applyRecoveredText(projected, candidate.sourceText, recovered.text) : undefined;
        if (!recovered || !next) {
          diagnostics.push({
            level: "warning",
            code: "mineru-pdf-text-recovery-abstained",
            message: `第 ${candidate.pageIndex + 1} 页存在无法唯一恢复的缺失字符；已保留 MinerU 原文。`
          });
          continue;
        }
        projected = next;
        recoveredCount += recovered.recoveredCount;
      }
      if (recovery.sourceArticleText && recovery.paragraphRecoveries?.length) {
        for (const request of recovery.paragraphRecoveries) {
          const { viewport, items } = await pageData(request.pageIndex);
          const pdfText = textInBbox(viewport, items, request.bbox);
          const recovered = recoverMinerUParagraph(recovery.sourceArticleText, request, pdfText);
          const next = recovered ? applyRecoveredParagraph(projected, recovered) : undefined;
          if (!recovered || !next) {
            diagnostics.push({
              level: "warning",
              code: "mineru-pdf-paragraph-recovery-abstained",
              message: `第 ${request.pageIndex + 1} 页的空白正文块无法唯一恢复，已保留原始显示。`
            });
            continue;
          }
          projected = next;
          recoveredParagraphCount += 1;
        }
      }
      if (recovery.sourceArticleText && recovery.captionContinuations?.length) {
        for (const request of recovery.captionContinuations) {
          const { viewport, items } = await pageData(request.pageIndex);
          const pdfText = textInBbox(viewport, items, request.bbox);
          const recovered = recoverPdfCaptionContinuation(recovery.sourceArticleText, request, pdfText);
          const next = recovered ? suppressRecoveredCaptionContinuation(projected, recovered) : undefined;
          if (!recovered || !next) {
            diagnostics.push({
              level: "warning",
              code: "mineru-pdf-caption-continuation-abstained",
              message: `第 ${request.pageIndex + 1} 页的跨栏续图注无法唯一映射到 Markdown，已保留原文。`
            });
            continue;
          }
          projected = next;
          captionUpdates.push({
            visualId: recovered.visualId,
            captionText: recovered.captionText,
            captionStatus: recovered.captionStatus
          });
          recoveredCaptionCount += 1;
        }
      }
    } catch (error) {
      diagnostics.push({
        level: "warning",
        code: "mineru-pdf-text-recovery-unavailable",
        message: `PDF 文本层不可用，缺失字符保持原样：${error instanceof Error ? error.message : String(error)}`
      });
    }
    if (recoveredCount) {
      diagnostics.push({
        level: "info",
        code: "mineru-pdf-text-recovered",
        message: `已从原 PDF 文本层恢复 ${recoveredCount} 个缺失字符；仅用于当前显示。`
      });
    }
    if (recoveredCaptionCount) {
      diagnostics.push({
        level: "info",
        code: "mineru-pdf-caption-continuation-recovered",
        message: `已从原 PDF 文本层恢复 ${recoveredCaptionCount} 处跨栏续图注；仅用于当前显示。`
      });
    }
    if (recoveredParagraphCount) {
      diagnostics.push({
        level: "info",
        code: "mineru-pdf-paragraph-recovered",
        message: `已从原 PDF 文本层恢复 ${recoveredParagraphCount} 个完整正文段落；仅用于当前显示。`
      });
    }
    return { articleText: projected, diagnostics, captionUpdates };
  }

  dispose(): void {
    this.cancelPageRender();
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.document = undefined;
    this.documentPromise = undefined;
    this.fileSystem = undefined;
    this.pdfPath = undefined;
    const loadingTask = this.loadingTask;
    this.loadingTask = undefined;
    if (loadingTask) void loadingTask.destroy();
  }

  private async loadDocument(fileSystem: ReaderFileSystem, pdfPath: string): Promise<PDFDocumentProxy> {
    if (this.fileSystem !== fileSystem || this.pdfPath !== pdfPath || !this.documentPromise) {
      this.dispose();
      this.fileSystem = fileSystem;
      this.pdfPath = pdfPath;
      this.documentPromise = fileSystem.readBinary(pdfPath)
        .then(async (bytes) => {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
          this.loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
          return this.loadingTask.promise;
        })
        .then((document) => {
          this.document = document;
          return document;
        });
    }
    return this.documentPromise;
  }
}
