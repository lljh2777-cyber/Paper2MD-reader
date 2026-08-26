import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import { LoadedAsset, NormalizedBBox } from "../../../src/model/reader-contract";

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
