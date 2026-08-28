import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import type { ReaderProcessingProgress } from "../../../packages/reader-core/src/index";
import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";

const MAX_BROWSER_PDF_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_PDF_PAGES = 200;

export interface BrowserPdfPackageResult {
  fileSystem: BrowserDirectoryReaderFileSystem;
  files: ReadonlyMap<string, File>;
  archiveName: string;
  pageCount: number;
  extractedCharacterCount: number;
}

function safeStem(filename: string): string {
  return filename
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "paper";
}

function markdownText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

export function projectPdfTextPages(filename: string, pages: readonly string[]): string {
  const title = safeStem(filename).replace(/([\\`*{}[\]()#+\-.!_>])/g, "\\$1");
  const body = pages.map((page, index) => {
    const text = markdownText(page);
    return `## 第 ${index + 1} 页\n\n${text || "_本页没有可提取的文本层；请在右侧原 PDF 参考视图中查看。_"}`;
  }).join("\n\n");
  return [
    `# ${title}`,
    "> 此 Markdown 是浏览器从原 PDF 文本层生成的派生阅读投影。原 PDF 保持不变；未能唯一确定的版式、图注与视觉关系不会被猜测或写回。",
    body
  ].join("\n\n") + "\n";
}

async function extractPages(document: PDFDocumentProxy, onProgress: (progress: ReaderProcessingProgress) => void): Promise<string[]> {
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress({ state: "running", stage: "extract", message: `正在浏览器内解析第 ${pageNumber}/${document.numPages} 页…` });
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const value = String(item.str).replace(/\u0000/g, "");
      if (!value) continue;
      text += value;
      text += "hasEOL" in item && item.hasEOL ? "\n" : " ";
    }
    pages.push(text);
    page.cleanup();
  }
  return pages;
}

export async function processBrowserPdf(file: File, onProgress: (progress: ReaderProcessingProgress) => void): Promise<BrowserPdfPackageResult> {
  if (file.size < 5 || file.size > MAX_BROWSER_PDF_BYTES) {
    throw new Error(`浏览器本地解析仅接受 5 字节至 ${MAX_BROWSER_PDF_BYTES / 1024 / 1024} MB 的 PDF。`);
  }
  const signature = new TextDecoder("ascii").decode(await file.slice(0, 5).arrayBuffer());
  if (signature !== "%PDF-") throw new Error("所选文件不是有效的 PDF。");

  onProgress({ state: "running", stage: "extract", message: "正在浏览器内打开 PDF；文件不会上传…" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const scope = globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler } };
  scope.pdfjsWorker ??= { WorkerMessageHandler };
  const loadingTask = pdfjs.getDocument({ data: bytes, verbosity: pdfjs.VerbosityLevel.ERRORS });
  let document: PDFDocumentProxy | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_BROWSER_PDF_PAGES) {
      throw new Error(`浏览器本地解析最多支持 ${MAX_BROWSER_PDF_PAGES} 页；请改用桌面版处理更长论文。`);
    }
    const pages = await extractPages(document, onProgress);
    const article = projectPdfTextPages(file.name, pages);
    const files = new Map<string, File>([
      ["article.md", new File([article], "article.md", { type: "text/markdown" })],
      ["_extraction/source.pdf", file]
    ]);
    const stem = safeStem(file.name);
    onProgress({ state: "succeeded", stage: "complete", message: "本地文本投影已生成；正在执行 Reader 的确定性校验与展示。" });
    return {
      fileSystem: BrowserDirectoryReaderFileSystem.fromFileMap(stem, files),
      files,
      archiveName: `${stem}.paper2md.zip`,
      pageCount: document.numPages,
      extractedCharacterCount: pages.reduce((total, page) => total + markdownText(page).length, 0)
    };
  } finally {
    if (document) await document.cleanup();
    await loadingTask.destroy();
  }
}
