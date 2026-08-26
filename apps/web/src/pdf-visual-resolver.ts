import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import { Diagnostic, LoadedAsset, NormalizedBBox } from "../../../src/model/reader-contract";
import {
  applyRecoveredText,
  MinerUTextRecoveryCandidate,
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

export class PdfVisualResolver {
  private fileSystem?: ReaderFileSystem;
  private pdfPath?: string;
  private documentPromise?: Promise<PDFDocumentProxy>;
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private readonly urls = new Set<string>();

  async resolve(asset: LoadedAsset, fileSystem: ReaderFileSystem): Promise<string> {
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
    recovery: { pdfPath: string; candidates: MinerUTextRecoveryCandidate[] },
    fileSystem: ReaderFileSystem
  ): Promise<{ articleText: string; diagnostics: Diagnostic[] }> {
    const diagnostics: Diagnostic[] = [];
    let projected = articleText;
    let recoveredCount = 0;
    try {
      const document = await this.loadDocument(fileSystem, recovery.pdfPath);
      const pageCache = new Map<number, Promise<{
        viewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>;
        items: Array<{ text: string; x: number; centerY: number; width: number }>;
      }>>();
      for (const candidate of recovery.candidates) {
        const pageNumber = Math.max(1, Math.min(document.numPages, candidate.pageIndex + 1));
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
        const { viewport, items } = await pageCache.get(pageNumber)!;
        const padding = 0.015;
        const left = Math.max(0, candidate.bbox.x - padding) * viewport.width;
        const right = Math.min(1, candidate.bbox.x + candidate.bbox.width + padding) * viewport.width;
        const top = Math.max(0, candidate.bbox.y - padding) * viewport.height;
        const bottom = Math.min(1, candidate.bbox.y + candidate.bbox.height + padding) * viewport.height;
        const blockText = items
          .filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 <= right && item.centerY >= top && item.centerY <= bottom)
          .map((item) => item.text)
          .join(" ");
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
    return { articleText: projected, diagnostics };
  }

  dispose(): void {
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
