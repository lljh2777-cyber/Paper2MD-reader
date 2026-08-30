import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountWebReaderWithReady } from "../apps/web/src/main";
import { PackageLoader } from "../src/model/package-loader";
import type { LoadedPaperPackage } from "../src/model/reader-contract";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installDom(): HTMLElement {
  const { document, window } = parseHTML("<html><body><main id='reader'></main></body></html>");
  const selectValues = new WeakMap<object, string>();
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return selectValues.get(this) ?? ""; },
    set(value: string) { selectValues.set(this, String(value)); }
  });
  Object.assign(window, {
    location: { origin: "https://after-mineru.example", pathname: "/reader", search: "", hash: "" }
  });
  class TestIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLCanvasElement", window.HTMLCanvasElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("CustomEvent", window.CustomEvent);
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  vi.stubGlobal("navigator", { language: "en", languages: ["en"] });
  return document.querySelector<HTMLElement>("#reader")!;
}

function loadedPackage(): LoadedPaperPackage {
  return {
    state: "markdown",
    sourceFormat: "markdown",
    articlePath: "article.md",
    articleText: "# Ready\n",
    articleHash: "1".repeat(64),
    anchors: {
      blockIds: [],
      slotIds: [],
      duplicateIds: [],
      malformedMarkers: [],
      blockKinds: new Map(),
      slotAssets: new Map()
    },
    assets: [],
    diagnostics: []
  };
}

describe("web Reader initial mount readiness", () => {
  it("makes strict-readonly close every mutating Web capability even when legacy flags are enabled", async () => {
    const root = installDom();
    const registerTool = vi.fn(async () => undefined);
    (document as Document & { modelContext?: { registerTool: typeof registerTool } }).modelContext = { registerTool };
    (window as Window & { __PAPER2MD_READER_CONFIG__?: { processingApiBaseUrl?: string } })
      .__PAPER2MD_READER_CONFIG__ = { processingApiBaseUrl: "http://untrusted.example" };
    const persistentStorage = {
      getItem: vi.fn((_key: string) => null),
      setItem: vi.fn((_key: string, _value: string) => undefined)
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: persistentStorage });
    const source = new MemoryReaderFileSystem({ "article.md": "# Strict\n" });
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loadedPackage());

    const mounted = mountWebReaderWithReady(root, {
      initialFileSystem: source,
      capabilityProfile: "strict-readonly",
      allowPdfProjection: true,
      allowDirectPdfOpen: true,
      allowRuntimeTextRecovery: true,
      enableWebMcp: true,
      enableProcessingApi: true,
      persistPaperState: true
    });

    await expect(mounted.ready).resolves.toBeUndefined();
    expect(document.querySelector('input[data-reader-pdf-mode="projection"]')).toBeNull();
    expect(document.querySelector('input[data-reader-pdf-mode="direct"]')).not.toBeNull();
    expect(document.querySelector(".p2md-web-ingest")).toBeNull();
    expect(registerTool).not.toHaveBeenCalled();
    expect(persistentStorage.getItem.mock.calls.map(([key]) => key)).not.toContain(
      `paper2md-reader:view:v1:${"1".repeat(64)}`
    );

    mounted.dispose();
    expect(persistentStorage.setItem.mock.calls.map(([key]) => key)).not.toContain(
      `paper2md-reader:view:v1:${"1".repeat(64)}`
    );
  });

  it("resolves only after the initial package reaches a rendered state", async () => {
    const root = installDom();
    const source = new MemoryReaderFileSystem({ "article.md": "# Ready\n" });
    const disposeSource = vi.spyOn(source, "dispose");
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loadedPackage());

    const mounted = mountWebReaderWithReady(root, {
      initialFileSystem: source,
      capabilityProfile: "strict-readonly",
      allowPdfProjection: false,
      allowDirectPdfOpen: true,
      allowRuntimeTextRecovery: false,
      enableWebMcp: false,
      enableProcessingApi: false,
      persistPaperState: false
    });

    await expect(mounted.ready).resolves.toBeUndefined();
    expect(root.querySelector(".p2md-article")?.textContent).toContain("Ready");
    mounted.dispose();
    expect(disposeSource).toHaveBeenCalledTimes(1);
  });

  it("rejects readiness when the workspace renders a fail-closed load error", async () => {
    const root = installDom();
    const source = new MemoryReaderFileSystem({ "article.md": "# Invalid\n" });
    const disposeSource = vi.spyOn(source, "dispose");
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockRejectedValue(new Error("invalid package"));

    const mounted = mountWebReaderWithReady(root, {
      initialFileSystem: source,
      capabilityProfile: "strict-readonly",
      allowPdfProjection: false,
      allowRuntimeTextRecovery: false,
      enableWebMcp: false,
      enableProcessingApi: false,
      persistPaperState: false
    });

    await expect(mounted.ready).rejects.toThrow(/did not reach a rendered Reader state/);
    expect(root.dataset.state).toBe("error");
    mounted.dispose();
    expect(disposeSource).toHaveBeenCalledTimes(1);
  });
});
