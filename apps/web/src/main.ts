import "../../../styles.css";
import "../../../local-reader/local-reader.css";
import "katex/dist/katex.min.css";
import { mountReaderWorkspace, ReaderWorkspace } from "../../../packages/reader-ui/src/index";
import { BrowserPackagePicker } from "./browser-package-picker";
import { readerText, ReaderLocale } from "../../../src/ui/locale";
import { PdfVisualResolver } from "./pdf-visual-resolver";
import { configuredProcessingApiBaseUrl, ProcessingClient } from "./processing-client";

export function requestedPackageId(pathname: string): string | undefined {
  const match = /^\/reader\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/.exec(pathname);
  return match?.[1];
}

function webCopy(locale: ReaderLocale, pdfProcessingEnabled: boolean) {
  return {
    title: readerText(locale, "webTitle"),
    emptyTitle: readerText(locale, "webEmptyTitle"),
    emptyCopy: readerText(locale, "webEmptyCopy"),
    emptyNote: readerText(locale, pdfProcessingEnabled ? "webProcessingNote" : "webEmptyNote"),
    toolbarOpenLabel: readerText(locale, "openFolder"),
    emptyOpenLabel: readerText(locale, "openPaperFolder"),
    unselectedLabel: readerText(locale, "webNoFolder")
  };
}

export function mountWebReader(root: HTMLElement): () => void {
  const picker = new BrowserPackagePicker();
  const visualResolver = new PdfVisualResolver();
  const pdfProcessingEnabled = Boolean(picker.choosePdfPackage);
  const workspace: ReaderWorkspace = mountReaderWorkspace(root, {
    picker,
    visualResolver,
    pdfRuntime: visualResolver,
    localizedCopy: {
      en: webCopy("en", pdfProcessingEnabled),
      "zh-CN": webCopy("zh-CN", pdfProcessingEnabled)
    }
  });
  const packageId = requestedPackageId(window.location.pathname);
  const apiBaseUrl = configuredProcessingApiBaseUrl();
  if (packageId && apiBaseUrl) {
    void new ProcessingClient(apiBaseUrl).openPackage(packageId)
      .then((fileSystem) => workspace.attachFileSystem(fileSystem))
      .catch((error) => {
        console.error("Could not open linked Paper2MD package", error);
        root.dataset.state = "failed";
      });
  }
  return () => workspace.destroy();
}
