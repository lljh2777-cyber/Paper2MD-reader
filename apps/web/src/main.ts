import "../../../styles.css";
import "../../../local-reader/local-reader.css";
import "katex/dist/katex.min.css";
import { mountReaderWorkspace, ReaderWorkspace } from "../../../packages/reader-ui/src/index";
import { BrowserPackagePicker } from "./browser-package-picker";
import { readerText, ReaderLocale } from "../../../src/ui/locale";
import { PdfVisualResolver } from "./pdf-visual-resolver";
import { configuredProcessingApiBaseUrl, ProcessingClient } from "./processing-client";
import { registerReaderWebMcp } from "./reader-webmcp";
import { mountPaperIngestPanel } from "./paper-ingest-panel";
import "./paper-ingest-panel.css";
import type { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";

export interface WebReaderMountOptions {
  initialFileSystem?: ReaderFileSystem;
  enableWebMcp?: boolean;
  enableProcessingApi?: boolean;
}

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

export function mountWebReader(root: HTMLElement, options: WebReaderMountOptions = {}): () => void {
  const ingestHost = document.createElement("div");
  const readerHost = document.createElement("div");
  root.replaceChildren(ingestHost, readerHost);
  const picker = new BrowserPackagePicker(options.enableProcessingApi !== false);
  const visualResolver = new PdfVisualResolver();
  const pdfProcessingEnabled = Boolean(picker.choosePdfPackage);
  const packageId = requestedPackageId(window.location.pathname);
  const apiBaseUrl = options.enableProcessingApi === false ? undefined : configuredProcessingApiBaseUrl();
  const processingClient = apiBaseUrl ? new ProcessingClient(apiBaseUrl) : undefined;
  let activePackageId = packageId;
  const workspace: ReaderWorkspace = mountReaderWorkspace(readerHost, {
    picker,
    visualResolver,
    pdfRuntime: visualResolver,
    visualReviewStore: processingClient ? {
      read: async () => activePackageId ? processingClient.readVisualReviewSidecar(activePackageId) : undefined
    } : undefined,
    localizedCopy: {
      en: webCopy("en", pdfProcessingEnabled),
      "zh-CN": webCopy("zh-CN", pdfProcessingEnabled)
    }
  });
  const webMcp = options.enableWebMcp === false ? { dispose: () => undefined } : registerReaderWebMcp(
    workspace,
    document,
    navigator,
    processingClient ? {
      validate: async (candidateId, correction) => {
        if (!activePackageId) throw new Error("No published package is open");
        return processingClient.validateVisualCorrection(activePackageId, candidateId, correction);
      },
      apply: async (candidateId, correction, validationToken) => {
        if (!activePackageId) throw new Error("No published package is open");
        const result = await processingClient.applyVisualCorrection(activePackageId, candidateId, correction, validationToken);
        await workspace.refreshPackage();
        return result;
      }
    } : undefined
  );
  const disposeIngest = processingClient && !packageId
    ? mountPaperIngestPanel(ingestHost, processingClient, async (readyPackageId, readerUrl) => {
      const fileSystem = await processingClient.openPackage(readyPackageId);
      activePackageId = readyPackageId;
      history.replaceState(null, "", new URL(readerUrl).pathname);
      ingestHost.replaceChildren();
      await workspace.attachFileSystem(fileSystem);
    })
    : () => undefined;
  if (packageId && apiBaseUrl) {
    void processingClient!.openPackage(packageId)
      .then((fileSystem) => workspace.attachFileSystem(fileSystem))
      .catch((error) => {
        console.error("Could not open linked Paper2MD package", error);
        root.dataset.state = "error";
      });
  } else if (options.initialFileSystem) {
    void workspace.attachFileSystem(options.initialFileSystem).catch((error) => {
      console.error("Could not open the initial Paper2MD package", error);
      root.dataset.state = "error";
    });
  }
  return () => {
    disposeIngest();
    webMcp.dispose();
    workspace.destroy();
  };
}
