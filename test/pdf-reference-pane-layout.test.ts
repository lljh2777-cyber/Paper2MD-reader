import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderFileSystem } from "../src/filesystem/reader-file-system";
import { PdfReferencePane, type PdfReferenceRuntime } from "../src/render/pdf-reference-pane";

afterEach(() => vi.unstubAllGlobals());

function installDom(): {
  document: Document;
  flushFrames: () => void;
  notifyResize: () => void;
} {
  const { document, window } = parseHTML("<html><body><aside id=pdf></aside></body></html>");
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let resizeCallback: ResizeObserverCallback | undefined;
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLCanvasElement", window.HTMLCanvasElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("DOMException", window.DOMException);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "17px" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    document: document as unknown as Document,
    flushFrames: () => {
      const pending = [...frames.entries()];
      frames.clear();
      pending.forEach(([id, callback]) => callback(id));
    },
    notifyResize: () => resizeCallback?.([], {} as ResizeObserver)
  };
}

function fileSystem(): ReaderFileSystem {
  return {
    rootLabel: "test",
    resolvePath: (path) => path,
    exists: vi.fn(async () => true),
    fileInfo: vi.fn(async () => ({ size: 100 })),
    readText: vi.fn(async () => ""),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    listFiles: vi.fn(async () => []),
    resolveAssetUrl: vi.fn(async (path) => path),
    dispose: vi.fn()
  };
}

function runtime(): PdfReferenceRuntime & { renderPage: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => 1),
    renderPage: vi.fn(async (_page, _canvas, availableWidth, zoom) => ({
      width: availableWidth * zoom,
      height: availableWidth * zoom * 1.4
    })),
    cancelPageRender: vi.fn()
  };
}

describe("PDF reference pane responsive layout", () => {
  it("groups every toolbar action into the two-row narrow layout", () => {
    const { document } = installDom();
    const host = document.querySelector<HTMLElement>("#pdf")!;
    const pane = new PdfReferencePane(host, runtime(), "en");

    expect(host.querySelectorAll(".p2md-pdf-toolbar-group")).toHaveLength(3);
    expect(host.querySelector(".p2md-pdf-toolbar-page")?.children).toHaveLength(4);
    expect(host.querySelector(".p2md-pdf-toolbar-zoom")?.children).toHaveLength(4);
    expect(host.querySelector(".p2md-pdf-toolbar-view")?.children).toHaveLength(2);

    const stylesheet = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    const narrow = stylesheet.slice(
      stylesheet.indexOf("@container (max-width: 520px)"),
      stylesheet.indexOf(".p2md-pdf-scroll")
    );
    expect(narrow).toMatch(/\.p2md-pdf-toolbar\s*\{[^}]*display:\s*grid;/s);
    expect(narrow).toMatch(/"page follow"\s*"zoom view"/);
    expect(narrow).toMatch(/\.p2md-pdf-follow-label\s*\{\s*display:\s*none;/);
    pane.destroy();
  });

  it("rebuilds at the new fit width after a narrow resize", async () => {
    const { document, flushFrames, notifyResize } = installDom();
    const host = document.querySelector<HTMLElement>("#pdf")!;
    const pdfRuntime = runtime();
    const pane = new PdfReferencePane(host, pdfRuntime, "en");
    const scroll = host.querySelector<HTMLElement>(".p2md-pdf-scroll")!;
    let clientWidth = 480;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, get: () => clientWidth });
    Object.defineProperty(scroll, "scrollTo", { configurable: true, value: vi.fn() });

    pane.setVisible(true);
    await pane.setSource(fileSystem(), "source.pdf");
    await vi.waitFor(() => expect(pdfRuntime.renderPage).toHaveBeenCalled());
    expect(pdfRuntime.renderPage.mock.calls.at(-1)?.[2]).toBe(446);

    clientWidth = 280;
    notifyResize();
    flushFrames();
    await vi.waitFor(() => expect(pdfRuntime.renderPage).toHaveBeenCalledTimes(2));
    expect(pdfRuntime.renderPage.mock.calls.at(-1)?.[2]).toBe(246);
    pane.destroy();
  });

  it("rebuilds when Fit width is clicked even when zoom is already 100%", async () => {
    const { document } = installDom();
    const host = document.querySelector<HTMLElement>("#pdf")!;
    const pdfRuntime = runtime();
    const pane = new PdfReferencePane(host, pdfRuntime, "en");
    const scroll = host.querySelector<HTMLElement>(".p2md-pdf-scroll")!;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 480 });
    Object.defineProperty(scroll, "scrollTo", { configurable: true, value: vi.fn() });

    pane.setVisible(true);
    await pane.setSource(fileSystem(), "source.pdf");
    await vi.waitFor(() => expect(pdfRuntime.renderPage).toHaveBeenCalledTimes(1));
    host.querySelector<HTMLButtonElement>(".p2md-pdf-toolbar-view .p2md-pdf-fit-button")!.click();
    await vi.waitFor(() => expect(pdfRuntime.renderPage).toHaveBeenCalledTimes(2));
    pane.destroy();
  });

  it("keeps idle canvases out of layout until their page has rendered", () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(stylesheet).toMatch(/\.p2md-pdf-page\s+canvas\[hidden\]\s*\{\s*display:\s*none\s*;\s*\}/);
  });
});
