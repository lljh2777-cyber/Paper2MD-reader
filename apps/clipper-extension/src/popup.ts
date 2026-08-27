import { strToU8, zipSync } from "fflate";
import {
  MAX_CLIPPED_IMAGES,
  MAX_CLIPPED_ARTICLE_BYTES,
  MAX_CLIPPED_TOTAL_IMAGE_BYTES,
  MAX_CLIPPING_ARCHIVE_BYTES,
  buildClippingPackageFiles,
  collectMarkdownImages,
  extensionForMime,
  safeArchiveName,
  type LocalizedImage
} from "./clipping-package";
import {
  EXTRACT_MESSAGE,
  FETCH_IMAGE_MESSAGE,
  type ExtractPageResponse,
  type ExtractedPaperPage,
  type FetchImageResponse
} from "./messages";
import {
  buildClippingSubmissionFormData,
  publishClippingSubmission,
  requestProcessingServicePermission
} from "./processing-bridge";

function requiredElement<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Clipper popup is missing ${selector}.`);
  return node;
}

const titleElement = requiredElement<HTMLElement>("#page-title");
const clipButton = requiredElement<HTMLButtonElement>("#clip-button");
const exportButton = requiredElement<HTMLButtonElement>("#export-button");
const statusElement = requiredElement<HTMLElement>("#status");

let activeTab: chrome.tabs.Tab | undefined;

function setStatus(message: string, state: "working" | "error" | "success" = "working"): void {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function extractPage(tabId: number): Promise<{ page: ExtractedPaperPage; sourceHtml: string }> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["extractor.js"] });
  const response = await chrome.tabs.sendMessage(tabId, { type: EXTRACT_MESSAGE }) as ExtractPageResponse;
  if (!response?.ok) throw new Error(response?.error || "无法提取当前页面。");
  if (!response.page || typeof response.sourceHtml !== "string") throw new Error("页面提取器返回了无效结果。");
  return { page: response.page, sourceHtml: response.sourceHtml };
}

async function requestImageOrigins(urls: readonly string[]): Promise<Set<string>> {
  const origins = [...new Set(urls.map((url) => `${new URL(url).origin}/*`))];
  if (!origins.length) return new Set();
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return new Set();
  return new Set(origins.map((pattern) => pattern.slice(0, -2)));
}

async function fetchImage(url: string): Promise<FetchImageResponse> {
  return chrome.runtime.sendMessage({ type: FETCH_IMAGE_MESSAGE, url }) as Promise<FetchImageResponse>;
}

interface PreparedClipping {
  page: ExtractedPaperPage;
  sourceHtml: string;
  localizedImages: Map<string, LocalizedImage>;
  createdAt: string;
  filename: string;
  files: ReadonlyMap<string, Uint8Array>;
  included: number;
  omitted: number;
}

async function buildClipping(page: ExtractedPaperPage, sourceHtml: string): Promise<PreparedClipping> {
  if (strToU8(page.markdown).byteLength > MAX_CLIPPED_ARTICLE_BYTES) {
    throw new Error(`提取正文超过安全上限 ${Math.floor(MAX_CLIPPED_ARTICLE_BYTES / 1024 / 1024)} MiB。`);
  }
  const occurrences = collectMarkdownImages(page.markdown, page.sourceUrl);
  if (occurrences.length > MAX_CLIPPED_IMAGES) {
    throw new Error(`页面包含 ${occurrences.length} 张图片，超过安全上限 ${MAX_CLIPPED_IMAGES}。`);
  }
  const uniqueUrls = [...new Set(occurrences.flatMap((occurrence) => occurrence.absoluteUrl ? [occurrence.absoluteUrl] : []))];
  const grantedOrigins = await requestImageOrigins(uniqueUrls);
  const localized = new Map<string, LocalizedImage>();
  let totalImageBytes = 0;

  for (const [index, url] of uniqueUrls.entries()) {
    if (!grantedOrigins.has(new URL(url).origin)) continue;
    setStatus(`正在保存图片 ${index + 1}/${uniqueUrls.length}…`);
    const response = await fetchImage(url);
    if (!response.ok) continue;
    const extension = extensionForMime(response.mime);
    if (!extension) continue;
    const bytes = fromBase64(response.bytesBase64);
    if (totalImageBytes + bytes.length > MAX_CLIPPED_TOTAL_IMAGE_BYTES) break;
    totalImageBytes += bytes.length;
    localized.set(url, {
      url,
      path: `images/figure-${String(localized.size + 1).padStart(4, "0")}.${extension}`,
      mime: response.mime,
      bytes
    });
  }

  const created = new Date().toISOString();
  const clipping = await buildClippingPackageFiles({
    page,
    localizedImages: localized,
    createdAt: created,
    extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false }
  });
  return {
    page,
    sourceHtml,
    localizedImages: localized,
    createdAt: created,
    filename: safeArchiveName(page.title),
    files: clipping.files,
    included: clipping.includedImageCount,
    omitted: clipping.omittedImageCount
  };
}

function createArchive(clipping: PreparedClipping): Uint8Array {
  const bytes = zipSync(Object.fromEntries(clipping.files), { level: 6 });
  if (bytes.byteLength > MAX_CLIPPING_ARCHIVE_BYTES) {
    throw new Error(`生成的阅读包超过安全上限 ${Math.floor(MAX_CLIPPING_ARCHIVE_BYTES / 1024 / 1024)} MiB。`);
  }
  return bytes;
}

async function prepareClipping(tabId: number): Promise<PreparedClipping> {
  setStatus("正在提取论文正文…");
  const extracted = await extractPage(tabId);
  titleElement.textContent = extracted.page.title;
  return buildClipping(extracted.page, extracted.sourceHtml);
}

function setActionsDisabled(disabled: boolean): void {
  clipButton.disabled = disabled;
  exportButton.disabled = disabled;
}

async function downloadArchive(filename: string, bytes: Uint8Array): Promise<void> {
  const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([blobBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function initialize(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0];
  const url = activeTab?.url ?? "";
  if (!activeTab?.id || !/^https?:\/\//i.test(url)) {
    titleElement.textContent = "请在论文全文网页上使用此扩展。";
    setStatus("当前页面不支持提取。", "error");
    return;
  }
  titleElement.textContent = activeTab.title || url;
  setActionsDisabled(false);
  setStatus("准备就绪");
}

clipButton.addEventListener("click", () => {
  void (async () => {
    if (!activeTab?.id) return;
    setActionsDisabled(true);
    try {
      setStatus("正在请求本地服务权限…");
      if (!await requestProcessingServicePermission()) throw new Error("你没有授权访问本地 Paper2MD processing service。");
      const clipping = await prepareClipping(activeTab.id);
      setStatus("正在暂存并校验阅读包…");
      const form = buildClippingSubmissionFormData({
        page: clipping.page,
        sourceHtml: clipping.sourceHtml,
        localizedImages: clipping.localizedImages,
        createdAt: clipping.createdAt,
        extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false }
      });
      const published = await publishClippingSubmission(form);
      setStatus(`阅读包已发布：${clipping.included} 张图片已本地化${clipping.omitted ? `，${clipping.omitted} 张未包含` : ""}。`, "success");
      await chrome.tabs.create({ url: published.readerUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message === "Failed to fetch"
        ? "无法连接本地 processing service。请先在 Paper2MD-Reader 运行 npm run reader:dev。"
        : message, "error");
    } finally {
      setActionsDisabled(false);
    }
  })();
});

exportButton.addEventListener("click", () => {
  void (async () => {
    if (!activeTab?.id) return;
    setActionsDisabled(true);
    try {
      const archive = await prepareClipping(activeTab.id);
      setStatus("正在导出 ZIP 备份…");
      await downloadArchive(archive.filename, createArchive(archive));
      setStatus(`ZIP 备份已生成：${archive.included} 张图片已本地化${archive.omitted ? `，${archive.omitted} 张未包含` : ""}。`, "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setActionsDisabled(false);
    }
  })();
});

if (typeof chrome === "undefined" || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
  titleElement.textContent = "请从浏览器扩展菜单打开 Paper2MD Web Clipper。";
  setStatus("当前页面不是扩展运行环境。", "error");
} else {
  void initialize();
}
