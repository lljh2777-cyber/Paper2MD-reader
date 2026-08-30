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
  it("resolves only after the initial package reaches a rendered state", async () => {
    const root = installDom();
    const source = new MemoryReaderFileSystem({ "article.md": "# Ready\n" });
    const disposeSource = vi.spyOn(source, "dispose");
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loadedPackage());

    const mounted = mountWebReaderWithReady(root, {
      initialFileSystem: source,
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
