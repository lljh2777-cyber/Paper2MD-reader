export type ReaderLocale = "en" | "zh-CN";

export const READER_LOCALE_STORAGE_KEY = "paper2md-reader-locale";
export const READER_LOCALE_EVENT = "paper2md:locale-change";

const ENGLISH = {
  language: "Language",
  english: "English",
  chinese: "中文",
  readerTitle: "Paper2MD Reader",
  noPackageSelected: "No package selected",
  noPackage: "No package",
  loading: "Loading…",
  reloadPackage: "Reload package",
  openFolder: "Open folder",
  openPaperFolder: "Open paper folder",
  readPackage: "Read a Paper2MD package",
  choosePackageCopy: "Choose a folder containing article.md and _paper2md/reader.json.",
  contractValidatedNote: "Contract validated before linked reading is enabled",
  unableOpenPackage: "Unable to open package",
  chooseAnotherFolder: "Choose another folder",
  loadFailed: "Load failed",
  readerDiagnostics: "Reader diagnostics",
  noReaderContract: "No reader contract",
  noContractProblems: "No contract problems detected.",
  closeDiagnostics: "Close diagnostics",
  selectedPackageOpenFailed: "The selected package could not be opened.",
  missingArticle: "This folder does not contain article.md.",
  packageLoadFailed: "The paper package could not be loaded. Check the folder and retry.",
  visuals: "Visuals",
  followReading: "Follow reading",
  followReadingHelp: "Automatically show the visual at the current reading position",
  noVisuals: "No visual assets available",
  noVisualsCopy: "The article remains available in the main column.",
  imageUnavailable: "Image unavailable",
  openImage: "Open image",
  backToPosition: "Back to position",
  paperVisualAssets: "Paper visual assets",
  openNamed: "Open {name}",
  showNamed: "Show {name}",
  closeNamed: "Close {name}",
  closeReader: "Close Paper2MD Reader",
  noArticle: "No article",
  reloadArticle: "Reload article",
  openArticleInstruction: "Open an article.md file, then run ‘Open in Paper2MD Reader’.",
  articleNotFound: "Article not found: {path}",
  articleLoadFailed: "The paper could not be loaded. Open diagnostics or retry.",
  articleLoadNotice: "Paper2MD Reader could not load this article.",
  statusValid: "Contract valid",
  statusEdited: "Article edited · anchors valid",
  statusRecoverable: "Anchor mismatch",
  statusAmbiguous: "Anchor conflict",
  statusReaderMissing: "Markdown fallback",
  statusUnsupported: "Unsupported contract",
  statusInvalid: "Invalid contract",
  webTitle: "Paper2MD Local Reader",
  webEmptyTitle: "Read a Paper2MD package locally",
  webEmptyCopy: "Choose a folder containing article.md and _paper2md/reader.json. Files stay on this device.",
  webEmptyNote: "Read-only · no upload · Chrome or Edge recommended",
  webNoFolder: "No folder selected",
  desktopReaderTitle: "Paper2MD Reader Desktop",
  desktopEmptyTitle: "Open or process a paper",
  desktopEmptyCopy: "Open an existing Paper2MD package, or process a local PDF from the task panel.",
  desktopEmptyNote: "Local filesystem access is isolated behind the desktop adapter",
  openPackage: "Open package"
} as const;

export type ReaderMessageKey = keyof typeof ENGLISH;

const CHINESE: Record<ReaderMessageKey, string> = {
  language: "语言",
  english: "English",
  chinese: "中文",
  readerTitle: "Paper2MD 阅读器",
  noPackageSelected: "尚未选择内容包",
  noPackage: "无内容包",
  loading: "正在加载…",
  reloadPackage: "重新加载内容包",
  openFolder: "打开文件夹",
  openPaperFolder: "打开论文文件夹",
  readPackage: "阅读 Paper2MD 内容包",
  choosePackageCopy: "请选择包含 article.md 和 _paper2md/reader.json 的文件夹。",
  contractValidatedNote: "通过契约校验后启用正文与图片联动",
  unableOpenPackage: "无法打开内容包",
  chooseAnotherFolder: "选择其他文件夹",
  loadFailed: "加载失败",
  readerDiagnostics: "阅读器诊断",
  noReaderContract: "无 Reader 契约",
  noContractProblems: "未发现契约问题。",
  closeDiagnostics: "关闭诊断",
  selectedPackageOpenFailed: "无法打开所选内容包。",
  missingArticle: "该文件夹不包含 article.md。",
  packageLoadFailed: "无法加载论文内容包，请检查文件夹后重试。",
  visuals: "图表",
  followReading: "跟随阅读",
  followReadingHelp: "自动显示当前阅读位置对应的图表",
  noVisuals: "没有可用图表",
  noVisualsCopy: "正文仍可在主栏中阅读。",
  imageUnavailable: "图片不可用",
  openImage: "打开图片",
  backToPosition: "返回正文位置",
  paperVisualAssets: "论文图表资源",
  openNamed: "打开{name}",
  showNamed: "显示{name}",
  closeNamed: "关闭{name}",
  closeReader: "关闭 Paper2MD 阅读器",
  noArticle: "未打开文章",
  reloadArticle: "重新加载文章",
  openArticleInstruction: "请先打开 article.md，然后运行“在 Paper2MD 阅读器中打开”。",
  articleNotFound: "未找到文章：{path}",
  articleLoadFailed: "无法加载论文，请打开诊断信息或重试。",
  articleLoadNotice: "Paper2MD 阅读器无法加载这篇文章。",
  statusValid: "契约有效",
  statusEdited: "正文已编辑 · 锚点有效",
  statusRecoverable: "锚点不匹配",
  statusAmbiguous: "锚点冲突",
  statusReaderMissing: "Markdown 降级模式",
  statusUnsupported: "不支持的契约版本",
  statusInvalid: "契约无效",
  webTitle: "Paper2MD 本地阅读器",
  webEmptyTitle: "在本地阅读 Paper2MD 内容包",
  webEmptyCopy: "请选择包含 article.md 和 _paper2md/reader.json 的文件夹，文件不会离开本设备。",
  webEmptyNote: "只读 · 不上传 · 推荐使用 Chrome 或 Edge",
  webNoFolder: "尚未选择文件夹",
  desktopReaderTitle: "Paper2MD 桌面阅读器",
  desktopEmptyTitle: "打开或处理一篇论文",
  desktopEmptyCopy: "打开已有 Paper2MD 内容包，或从任务面板处理本地 PDF。",
  desktopEmptyNote: "本地文件系统访问被隔离在桌面适配层之后",
  openPackage: "打开内容包"
};

const COPY: Record<ReaderLocale, Record<ReaderMessageKey, string>> = {
  en: ENGLISH,
  "zh-CN": CHINESE
};

export function normalizeReaderLocale(value: unknown): ReaderLocale | undefined {
  if (value === "en" || value === "zh-CN") return value;
  if (typeof value === "string" && value.toLowerCase().startsWith("zh")) return "zh-CN";
  if (typeof value === "string" && value.toLowerCase().startsWith("en")) return "en";
  return undefined;
}

export function readerText(locale: ReaderLocale, key: ReaderMessageKey, values: Record<string, string | number> = {}): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    COPY[locale][key]
  );
}

export function getReaderLocale(): ReaderLocale {
  try {
    const saved = normalizeReaderLocale(globalThis.localStorage?.getItem(READER_LOCALE_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // Storage can be disabled by the host; system language remains a safe fallback.
  }
  const languages = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.map(normalizeReaderLocale).find((locale): locale is ReaderLocale => Boolean(locale)) ?? "en";
}

export function setReaderLocale(locale: ReaderLocale): void {
  try {
    globalThis.localStorage?.setItem(READER_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Language still changes for this session when storage is unavailable.
  }
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ReaderLocale>(READER_LOCALE_EVENT, { detail: locale }));
  }
}

export function subscribeReaderLocale(callback: (locale: ReaderLocale) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    const locale = normalizeReaderLocale((event as CustomEvent<unknown>).detail);
    if (locale) callback(locale);
  };
  window.addEventListener(READER_LOCALE_EVENT, listener);
  return () => window.removeEventListener(READER_LOCALE_EVENT, listener);
}
