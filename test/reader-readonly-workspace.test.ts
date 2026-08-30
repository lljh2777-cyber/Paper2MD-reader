import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountReaderWorkspace } from "../packages/reader-ui/src/reader-workspace";
import { PackageLoader } from "../src/model/package-loader";
import type { LoadedPaperPackage } from "../src/model/reader-contract";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installDom(): Document {
  const { document, window } = parseHTML("<html><body><main id='reader'></main></body></html>");
  const selectValues = new WeakMap<object, string>();
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return selectValues.get(this) ?? ""; },
    set(value: string) { selectValues.set(this, String(value)); }
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
  return document as unknown as Document;
}

describe("ReaderWorkspace strict read-only mode", () => {
  it("discards a stale package load without crossing or disposing the current content session", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const packageFor = (title: string, contentFileSystem: MemoryReaderFileSystem): LoadedPaperPackage => ({
      state: "valid",
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      contentFileSystem,
      articlePath: "derived/article.after-mineru.md",
      articleText: `# ${title}\n`,
      articleHash: title.repeat(64).slice(0, 64),
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
    });
    const sourceA = new MemoryReaderFileSystem({ "article.md": "# A\n" });
    const sourceB = new MemoryReaderFileSystem({ "article.md": "# B\n" });
    const contentA = new MemoryReaderFileSystem({ "derived/article.after-mineru.md": "# A\n" });
    const contentB = new MemoryReaderFileSystem({ "derived/article.after-mineru.md": "# B\n" });
    const disposeA = vi.spyOn(contentA, "dispose");
    const disposeB = vi.spyOn(contentB, "dispose");
    let resolveA!: (loaded: LoadedPaperPackage) => void;
    const pendingA = new Promise<LoadedPaperPackage>((resolve) => { resolveA = resolve; });
    vi.spyOn(PackageLoader.prototype, "loadDetected")
      .mockImplementationOnce(async () => pendingA)
      .mockResolvedValueOnce(packageFor("B", contentB));
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "web", choosePackage: vi.fn(async () => undefined) }
    });

    const attachA = workspace.attachFileSystem(sourceA);
    await workspace.attachFileSystem(sourceB);
    resolveA(packageFor("A", contentA));
    await attachA;

    expect(root.querySelector(".p2md-article")?.textContent).toContain("B");
    expect(root.querySelector(".p2md-article")?.textContent).not.toContain("A");
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    workspace.destroy();
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it("renders verified package content through its bound file system and disposes both owners", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const articleText = "# Verified paper\n\n![](images/figure.png)\n";
    const sourceFileSystem = new MemoryReaderFileSystem({ "article.md": articleText });
    const contentFileSystem = new MemoryReaderFileSystem({
      "derived/article.after-mineru.md": articleText,
      "images/figure.png": new Uint8Array([137, 80, 78, 71])
    });
    const sourceResolveAssetUrl = vi.spyOn(sourceFileSystem, "resolveAssetUrl");
    const sourceDispose = vi.spyOn(sourceFileSystem, "dispose");
    const contentResolveAssetUrl = vi.spyOn(contentFileSystem, "resolveAssetUrl");
    const contentDispose = vi.spyOn(contentFileSystem, "dispose");
    const loaded: LoadedPaperPackage = {
      state: "valid",
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      contentFileSystem,
      articlePath: "derived/article.after-mineru.md",
      articleText,
      articleHash: "b".repeat(64),
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
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "web", choosePackage: vi.fn(async () => undefined) }
    });

    await workspace.attachFileSystem(sourceFileSystem);

    expect(contentResolveAssetUrl).toHaveBeenCalledWith("images/figure.png");
    expect(sourceResolveAssetUrl).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLImageElement>(".p2md-article img")?.src).toBe("memory://images/figure.png");

    workspace.destroy();
    expect(contentDispose).toHaveBeenCalledTimes(1);
    expect(sourceDispose).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a host PDF text resolver even if a legacy loader exposes recovery work", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const sourceText = "# Raw paper\n\nThe original � remains visible.\n";
    const loaded: LoadedPaperPackage = {
      state: "mineru",
      sourceFormat: "mineru",
      packageIntegrity: "unverified",
      articlePath: "article.md",
      articleText: sourceText,
      articleHash: "a".repeat(64),
      anchors: {
        blockIds: [],
        slotIds: [],
        duplicateIds: [],
        malformedMarkers: [],
        blockKinds: new Map(),
        slotAssets: new Map()
      },
      assets: [],
      diagnostics: [],
      textRecovery: {
        pdfPath: "_extraction/source.pdf",
        candidates: [{
          id: "mineru-text-000000",
          pageIndex: 0,
          bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
          sourceText: "The original � remains visible."
        }]
      }
    };
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const recoverText = vi.fn(async () => ({
      articleText: "# Raw paper\n\nThe repaired symbol is X.\n",
      diagnostics: []
    }));
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "web", choosePackage: vi.fn(async () => undefined) },
      allowRuntimeTextRecovery: false,
      visualResolver: {
        resolve: vi.fn(async () => ""),
        recoverText,
        dispose: vi.fn()
      }
    });

    await workspace.attachFileSystem(new MemoryReaderFileSystem({ "article.md": sourceText }));

    expect(recoverText).not.toHaveBeenCalled();
    expect(root.querySelector(".p2md-article")?.textContent).toContain("original � remains visible");
    workspace.destroy();
  });

  it("opens a direct PDF as an ephemeral PDF-only session without loading or repairing a package", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const loadDetected = vi.spyOn(PackageLoader.prototype, "loadDetected");
    const recoverText = vi.fn(async () => ({ articleText: "generated Markdown", diagnostics: [] }));
    const open = vi.fn(async () => 2);
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    };
    const pdfRuntime = {
      open,
      renderPage: vi.fn(async () => ({ width: 800, height: 1000 })),
      cancelPageRender: vi.fn()
    };
    const visualResolver = {
      resolve: vi.fn(async () => ""),
      recoverText,
      dispose: vi.fn()
    };
    const workspace = mountReaderWorkspace(root, {
      picker: {
        platform: "web",
        choosePackage: vi.fn(async () => undefined),
        choosePdfDocument: vi.fn(async () => undefined)
      },
      paperStateStorage: storage,
      visualResolver,
      pdfRuntime
    });
    const fileSystem = new MemoryReaderFileSystem({ "_reader/source.pdf": "%PDF-1.7\nfixture" });

    await workspace.attachPdfDocument({
      fileSystem,
      pdfPath: "_reader/source.pdf",
      label: "fixture.pdf"
    });

    expect(loadDetected).not.toHaveBeenCalled();
    expect(recoverText).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(fileSystem, "_reader/source.pdf");
    expect(root.dataset.state).toBe("ready");
    expect(root.classList.contains("p2md-pdf-document-mode")).toBe(true);
    expect(root.querySelector(".p2md-file-label")?.textContent).toBe("fixture.pdf");
    expect(root.querySelector(".p2md-pdf-document-placeholder")?.textContent).toContain("No Markdown is generated");
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".p2md-reference-tab")];
    const pdfTab = tabs.find((tab) => tab.textContent === "Original PDF")!;
    const visualsTab = tabs.find((tab) => tab.textContent === "Images and captions")!;
    expect(pdfTab.hidden).toBe(false);
    expect(pdfTab.getAttribute("aria-selected")).toBe("true");
    expect(visualsTab.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".p2md-reference-pdf")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".p2md-reference-visuals")?.hidden).toBe(true);
    expect(workspace.getReaderState().reference).toMatchObject({
      mode: "pdf",
      pdfAvailable: true
    });
    expect(workspace.getReaderState().visualCount).toBe(0);
    expect(() => workspace.setReferenceMode("visuals")).toThrow(/unavailable/);
    expect(workspace.setReferenceMode("pdf").mode).toBe("pdf");
    expect(storage.setItem).not.toHaveBeenCalled();

    await workspace.refreshPackage();
    expect(loadDetected).not.toHaveBeenCalled();
    expect(recoverText).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);

    workspace.destroy();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
