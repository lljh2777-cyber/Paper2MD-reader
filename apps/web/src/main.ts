import "../../../styles.css";
import "../../../local-reader/local-reader.css";
import "katex/dist/katex.min.css";
import {
  mountReaderWorkspace,
  ReaderWorkspace,
  type ReaderCapabilityProfile,
  type ReaderPaperStateStorage,
  type ReaderVisualReviewMode
} from "../../../packages/reader-ui/src/index";
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
  /**
   * Select strict Reader consumption or the historical v0.1.3 compatibility
   * surface. Strict mode overrides mutating legacy flags even if they are true.
   */
  capabilityProfile?: ReaderCapabilityProfile;
  /** Override legacy visual-review visibility outside strict read-only mode. */
  visualReviewMode?: ReaderVisualReviewMode;
  /**
   * Allow a selected PDF to be converted into a generated Markdown package.
   * Set false on read-only Reader routes; existing Local Reader entry points
   * retain the historical default of true.
   */
  allowPdfProjection?: boolean;
  /**
   * Allow an original PDF to be rendered in an ephemeral, PDF-only Reader
   * session. This is independent from PDF-to-Markdown projection and defaults
   * to false so existing entry points keep their current UI.
   */
  allowDirectPdfOpen?: boolean;
  /**
   * Allow legacy in-memory text repair from a bundled PDF. Set false together
   * with allowPdfProjection on strict read-only Reader routes.
   */
  allowRuntimeTextRecovery?: boolean;
  /** Set false for ephemeral hosts; strict-readonly always keeps paper-derived state in memory. */
  persistPaperState?: boolean;
}

export interface WebReaderMountHandle {
  dispose(): void;
  /** Resolves only after an initial file system reaches a rendered Reader state. */
  ready: Promise<void>;
}

function createMemoryPaperStateStorage(): ReaderPaperStateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }
  };
}

export function requestedPackageId(pathname: string): string | undefined {
  const match = /^\/reader\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/.exec(pathname);
  return match?.[1];
}

function webCopy(locale: ReaderLocale, pdfProcessingEnabled: boolean, directPdfEnabled: boolean) {
  return {
    title: readerText(locale, "webTitle"),
    emptyTitle: readerText(locale, "webEmptyTitle"),
    emptyCopy: readerText(locale, directPdfEnabled ? "webPdfEmptyCopy" : "webEmptyCopy"),
    emptyNote: readerText(locale, pdfProcessingEnabled ? "webProcessingNote" : "webEmptyNote"),
    toolbarOpenLabel: readerText(locale, "openFolder"),
    emptyOpenLabel: readerText(locale, "openPaperFolder"),
    unselectedLabel: readerText(locale, "webNoFolder")
  };
}

export function mountWebReaderWithReady(
  root: HTMLElement,
  options: WebReaderMountOptions = {}
): WebReaderMountHandle {
  const strictReadOnly = options.capabilityProfile === "strict-readonly";
  const processingApiEnabled = !strictReadOnly && options.enableProcessingApi !== false;
  const pdfProjectionEnabled = !strictReadOnly && options.allowPdfProjection !== false;
  const webMcpEnabled = !strictReadOnly && options.enableWebMcp !== false;
  const runtimeTextRecoveryEnabled = !strictReadOnly && options.allowRuntimeTextRecovery !== false;
  const persistentPaperStateEnabled = !strictReadOnly && options.persistPaperState !== false;
  const ingestHost = document.createElement("div");
  const readerHost = document.createElement("div");
  root.replaceChildren(ingestHost, readerHost);
  const picker = new BrowserPackagePicker({
    enableProcessingApi: processingApiEnabled,
    allowPdfProjection: pdfProjectionEnabled,
    allowDirectPdfOpen: options.allowDirectPdfOpen === true
  });
  const visualResolver = new PdfVisualResolver();
  const pdfProcessingEnabled = Boolean(picker.choosePdfPackage);
  const directPdfEnabled = Boolean(picker.choosePdfDocument);
  const packageId = requestedPackageId(window.location.pathname);
  const apiBaseUrl = processingApiEnabled ? configuredProcessingApiBaseUrl() : undefined;
  const processingClient = apiBaseUrl ? new ProcessingClient(apiBaseUrl) : undefined;
  const paperStateStorage = !persistentPaperStateEnabled
    ? createMemoryPaperStateStorage()
    : undefined;
  let activePackageId = packageId;
  const workspace: ReaderWorkspace = mountReaderWorkspace(readerHost, {
    picker,
    capabilityProfile: options.capabilityProfile,
    allowRuntimeTextRecovery: runtimeTextRecoveryEnabled,
    visualReviewMode: strictReadOnly
      ? "disabled"
      : options.visualReviewMode ?? (processingClient ? "read-only" : undefined),
    paperStateStorage,
    visualResolver,
    pdfRuntime: visualResolver,
    visualReviewSource: processingClient ? {
      read: async () => activePackageId ? processingClient.readVisualReviewSidecar(activePackageId) : undefined
    } : undefined,
    localizedCopy: {
      en: webCopy("en", pdfProcessingEnabled, directPdfEnabled),
      "zh-CN": webCopy("zh-CN", pdfProcessingEnabled, directPdfEnabled)
    }
  });
  const webMcp = !webMcpEnabled ? { dispose: () => undefined } : registerReaderWebMcp(
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
  const attachAndRequireRenderedState = async (fileSystem: ReaderFileSystem): Promise<void> => {
    await workspace.attachFileSystem(fileSystem);
    const lifecycle = workspace.getReaderState().lifecycle;
    if (lifecycle !== "ready" && lifecycle !== "degraded") {
      throw new Error("The initial Paper2MD package did not reach a rendered Reader state.");
    }
  };
  let ready = Promise.resolve();
  if (packageId && apiBaseUrl) {
    ready = processingClient!.openPackage(packageId)
      .then(attachAndRequireRenderedState)
      .catch((error: unknown) => {
        console.error("Could not open linked Paper2MD package", error);
        root.dataset.state = "error";
        throw error;
      });
  } else if (options.initialFileSystem) {
    ready = attachAndRequireRenderedState(options.initialFileSystem).catch((error: unknown) => {
      console.error("Could not open the initial Paper2MD package", error);
      root.dataset.state = "error";
      throw error;
    });
  }
  return {
    ready,
    dispose() {
      disposeIngest();
      webMcp.dispose();
      workspace.destroy();
    }
  };
}

export function mountWebReader(root: HTMLElement, options: WebReaderMountOptions = {}): () => void {
  const mounted = mountWebReaderWithReady(root, options);
  // Historical callers receive a disposer and rely on the workspace's rendered
  // failure state. Consume the readiness rejection to preserve that contract.
  void mounted.ready.catch(() => undefined);
  return () => mounted.dispose();
}
