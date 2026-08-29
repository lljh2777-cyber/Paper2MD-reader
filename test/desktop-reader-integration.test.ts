import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountReaderWorkspace } from "../packages/reader-ui/src/reader-workspace";
import { PackageLoader } from "../src/model/package-loader";
import type { LoadedPaperPackage } from "../src/model/reader-contract";
import type { ArticleOutline } from "../src/render/article-outline";
import type { PdfReferenceRuntime } from "../src/render/pdf-reference-pane";
import type { MinerUVisualReview, MinerUVisualReviewDecision } from "../src/model/mineru-visual-review";
import type { ReaderArticleAnchor } from "../src/sync/reader-view-state";
import { setReaderLocale } from "../src/ui/locale";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installDom(): Document {
  const { document, window } = parseHTML(`
    <html><body>
      <main id="reader"></main>
      <aside id="references"></aside>
    </body></html>
  `);
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

describe("desktop Reader integration", () => {
  it("wires one PDF runtime and the external right pane into the shared Reader without an iframe path", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/main.ts"), "utf8");
    const mountStart = source.indexOf("const workspace = mountReaderWorkspace");
    const mountEnd = source.indexOf("const tasks =", mountStart);
    const mountBlock = source.slice(mountStart, mountEnd);

    expect(mountStart).toBeGreaterThanOrEqual(0);
    expect(mountEnd).toBeGreaterThan(mountStart);
    expect(mountBlock).toMatch(/visualResolver\s*,/);
    expect(mountBlock).toMatch(/visualReviewStore:\s*\{/);
    expect(mountBlock).toMatch(/read:\s*\(candidatePackageSha256\)\s*=>\s*api\.readVisualReviewSidecar/);
    expect(mountBlock).toMatch(/write:\s*\(candidatePackageSha256,\s*sidecar\)\s*=>\s*api\.writeVisualReviewSidecar/);
    expect(mountBlock).toMatch(/pdfRuntime:\s*visualResolver\s*,/);
    expect(mountBlock).toMatch(/figureHost:\s*rightPane\s*,/);
    expect(source).not.toMatch(/createElement\(["']iframe["']\)|element\(["']iframe["']/);
    expect(source).not.toContain("showPackagePdf");
  });

  it("keeps the synchronized reference pane reachable at the minimum desktop width", () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/desktop.css"), "utf8");
    const narrowStart = stylesheet.indexOf("@media (max-width: 1180px)");
    const narrowEnd = stylesheet.indexOf("@media (prefers-color-scheme: dark)", narrowStart);
    const narrowRules = stylesheet.slice(narrowStart, narrowEnd);

    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(narrowRules).not.toMatch(/\.p2md-desktop-right-pane\s*\{\s*display:\s*none\s*;/);
    expect(narrowRules).toMatch(/grid-template-columns:\s*minmax\(220px,\s*250px\)\s+minmax\(420px,\s*1fr\)\s+10px\s+minmax\(260px,\s*var\(--p2md-reference-width\)\)\s*;/);
    expect(narrowRules).toMatch(/data-reference-collapsed="true"[^}]*grid-template-columns:[^;]*10px\s+0\s*;/s);
  });

  it("creates the synchronized ReferenceSidebar when an external figure host and PDF runtime are both supplied", () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const rightPane = document.querySelector<HTMLElement>("#references")!;
    const pdfRuntime: PdfReferenceRuntime = {
      open: vi.fn(async () => 1),
      renderPage: vi.fn(async () => ({ width: 800, height: 1000 })),
      cancelPageRender: vi.fn()
    };
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) },
      figureHost: rightPane,
      pdfRuntime
    });

    expect(root.classList.contains("p2md-external-figures")).toBe(true);
    expect(rightPane.classList.contains("p2md-reference-host")).toBe(true);
    expect(rightPane.querySelector(".p2md-reference-tabs")).not.toBeNull();
    expect(rightPane.querySelector(".p2md-pdf-pane")).not.toBeNull();
    expect(rightPane.querySelector(".p2md-reference-visuals.p2md-figures")).not.toBeNull();
    expect(workspace.getReaderState().reference.available).toBe(true);
    workspace.destroy();
  });

  it("materializes a derived inline visual when a grouped repair has no surviving source image node", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const articleText = "# Paper\n\n<!-- p2md:slot id=\"slot-figure-3\" asset=\"figure-3\" -->\n";
    const loaded: LoadedPaperPackage = {
      state: "mineru",
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      articlePath: "article.md",
      articleText,
      articleHash: "a".repeat(64),
      anchors: {
        blockIds: [],
        slotIds: ["slot-figure-3"],
        duplicateIds: [],
        malformedMarkers: [],
        blockKinds: new Map(),
        slotAssets: new Map([["slot-figure-3", "figure-3"]])
      },
      assets: [{
        id: "figure-3",
        kind: "figure",
        path: "images/fragment-a.png",
        display_label: "Figure 3",
        caption_block_id: null,
        placement_block_id: "slot-figure-3",
        vaultPath: "images/fragment-a.png",
        exists: true,
        captionText: "Figure 3. Deterministically reconstructed from four source fragments.",
        memberAssetPaths: [
          "images/fragment-a.png",
          "images/fragment-b.png",
          "images/fragment-c.png",
          "images/fragment-d.png"
        ]
      }],
      diagnostics: []
    };
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const fileSystem = new MemoryReaderFileSystem({ "article.md": articleText });
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "web", choosePackage: vi.fn(async () => undefined) },
      visualResolver: {
        resolve: vi.fn(async () => "blob:verified-figure-3"),
        dispose: vi.fn()
      }
    });

    await workspace.attachFileSystem(fileSystem);

    const figure = root.querySelector<HTMLElement>('.p2md-derived-inline-asset[data-p2md-asset-id="figure-3"]');
    expect(figure).not.toBeNull();
    expect(figure?.querySelector("img")?.getAttribute("src")).toBe("blob:verified-figure-3");
    expect(figure?.querySelector("img")?.getAttribute("alt")).toBe("Figure 3");
    expect(figure?.querySelector("figcaption")?.textContent).toContain("four source fragments");
    expect(await fileSystem.readText("article.md")).toBe(articleText);
    workspace.destroy();
  });

  it("revalidates the same unique article anchor once after the first image layout settles", async () => {
    vi.useFakeTimers();
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) }
    });
    const harness = workspace as unknown as {
      articleScroll: HTMLElement;
      articleContent: HTMLElement;
      articleOutline: ArticleOutline;
      invalidateArticleLayout(): number;
      scheduleArticleAnchorRevalidation(anchor: ReaderArticleAnchor, generation: number): void;
    };
    const scroll = harness.articleScroll;
    const article = harness.articleContent;
    article.innerHTML = "<h1>Paper title</h1><img alt='figure'><h2>Methods</h2><h2>Results</h2>";
    const image = article.querySelector("img")!;
    Object.defineProperty(image, "complete", { configurable: true, value: false });
    const headings = [...article.querySelectorAll("h1, h2")] as unknown as HTMLElement[];
    const positions = [100, 1_000, 2_200];
    let scrollHeight = 3_000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight }
    });
    scroll.getBoundingClientRect = () => ({ top: 0, height: 400 } as DOMRect);
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => ({ top: positions[index] - scroll.scrollTop } as DOMRect);
    });
    scroll.scrollTop = 0;
    harness.articleOutline.setArticle(article);
    const anchor: ReaderArticleAnchor = {
      targetId: "p2md-outline-heading-2",
      label: "Methods",
      level: 2,
      sectionProgress: 0.3
    };
    expect(harness.articleOutline.restoreReadingAnchor(anchor)).toBe(true);
    expect(scroll.scrollTop).toBe(1_280);
    const restore = vi.spyOn(harness.articleOutline, "restoreReadingAnchor");
    const generation = harness.invalidateArticleLayout();
    harness.scheduleArticleAnchorRevalidation(anchor, generation);

    positions.splice(0, positions.length, 100, 1_400, 2_600);
    scrollHeight = 3_400;
    image.dispatchEvent(new window.Event("load"));
    await vi.runAllTimersAsync();

    expect(restore).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith(anchor);
    expect(scroll.scrollTop).toBe(1_680);
    image.dispatchEvent(new window.Event("error"));
    await vi.runAllTimersAsync();
    expect(restore).toHaveBeenCalledOnce();
    workspace.destroy();
  });

  it("cancels pending article-anchor revalidation for a replacement load or destroyed Reader", async () => {
    vi.useFakeTimers();
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) }
    });
    const harness = workspace as unknown as {
      articleContent: HTMLElement;
      articleOutline: ArticleOutline;
      invalidateArticleLayout(): number;
      scheduleArticleAnchorRevalidation(anchor: ReaderArticleAnchor, generation: number): void;
    };
    harness.articleContent.innerHTML = "<h1>Paper title</h1><img alt='figure'>";
    const image = harness.articleContent.querySelector("img")!;
    Object.defineProperty(image, "complete", { configurable: true, value: false });
    harness.articleOutline.setArticle(harness.articleContent);
    const restore = vi.spyOn(harness.articleOutline, "restoreReadingAnchor");
    const generation = harness.invalidateArticleLayout();
    harness.scheduleArticleAnchorRevalidation({
      targetId: "p2md-outline-heading-1",
      label: "Paper title",
      level: 1,
      sectionProgress: 0
    }, generation);

    harness.invalidateArticleLayout();
    image.dispatchEvent(new window.Event("load"));
    await vi.runAllTimersAsync();
    expect(restore).not.toHaveBeenCalled();

    const replacementGeneration = harness.invalidateArticleLayout();
    harness.scheduleArticleAnchorRevalidation({
      targetId: "p2md-outline-heading-1",
      label: "Paper title",
      level: 1,
      sectionProgress: 0
    }, replacementGeneration);
    workspace.destroy();
    image.dispatchEvent(new window.Event("error"));
    await vi.runAllTimersAsync();

    expect(restore).not.toHaveBeenCalled();
  });

  it("renders a PDF-recovered complete caption without the partial-caption warning", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const rightPane = document.querySelector<HTMLElement>("#references")!;
    const sourceArticle = "# Paper\n\nBody remains byte-identical.\n";
    const incompleteCaption = "Fig. 2 | Results through j, ROC curve showing";
    const completeCaption = `${incompleteCaption} k, Additional result. p, N-lactoyl-glutamine.`;
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": sourceArticle,
      "images/fig-2.png": new Uint8Array([1, 2, 3])
    });
    const loaded: LoadedPaperPackage = {
      state: "mineru",
      articlePath: "article.md",
      articleText: sourceArticle,
      articleHash: "a".repeat(64),
      anchors: {
        blockIds: [],
        slotIds: [],
        duplicateIds: [],
        malformedMarkers: [],
        blockKinds: new Map(),
        slotAssets: new Map()
      },
      assets: [{
        id: "fig-2",
        kind: "figure",
        path: "images/fig-2.png",
        display_label: "Fig. 2",
        caption_block_id: null,
        placement_block_id: null,
        vaultPath: "images/fig-2.png",
        exists: true,
        captionText: incompleteCaption,
        captionStatus: "partial"
      }],
      diagnostics: [],
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      textRecovery: {
        pdfPath: "_extraction/source.pdf",
        candidates: [],
        captionContinuations: [{
          visualId: "fig-2",
          sourceBlockId: "fig-2-source",
          pageIndex: 1,
          bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          anchorText: incompleteCaption,
          anchorProjected: true,
          candidateBlocks: []
        }]
      }
    };
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const recoverText = vi.fn(async (articleText: string) => ({
      articleText,
      diagnostics: [],
      captionUpdates: [{ visualId: "fig-2", captionText: completeCaption, captionStatus: "complete" as const }]
    }));
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) },
      figureHost: rightPane,
      visualResolver: {
        resolve: vi.fn(async () => "memory://images/fig-2.png"),
        recoverText,
        dispose: vi.fn()
      }
    });

    await workspace.attachFileSystem(fileSystem);

    expect(recoverText).toHaveBeenCalledOnce();
    expect(rightPane.querySelector(".p2md-figure-caption")?.textContent).toContain("p, N-lactoyl-glutamine.");
    expect(rightPane.querySelector(".p2md-figure-caption-note")).toBeNull();
    expect(workspace.listVisuals().items[0]).toEqual(expect.objectContaining({
      id: "fig-2",
      captionStatus: "complete",
      captionText: completeCaption
    }));
    expect(await fileSystem.readText("article.md")).toBe(sourceArticle);
    workspace.destroy();
  });

  it("preserves desktop host classes across locale rerenders without retaining stale Reader modes", () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const rightPane = document.querySelector<HTMLElement>("#references")!;
    root.classList.add("p2md-desktop-reader", "host-layout-marker", "p2md-contract-mode");
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) },
      figureHost: rightPane
    });

    expect(root.classList.contains("p2md-desktop-reader")).toBe(true);
    expect(root.classList.contains("host-layout-marker")).toBe(true);
    expect(root.classList.contains("p2md-contract-mode")).toBe(false);
    expect(root.classList.contains("p2md-external-figures")).toBe(true);

    root.classList.add("p2md-contract-mode");
    setReaderLocale("zh-CN");

    expect(root.classList.contains("p2md-desktop-reader")).toBe(true);
    expect(root.classList.contains("host-layout-marker")).toBe(true);
    expect(root.classList.contains("p2md-contract-mode")).toBe(false);
    expect(root.classList.contains("p2md-external-figures")).toBe(true);
    expect(root.querySelector<HTMLSelectElement>(".p2md-language-select")?.value).toBe("zh-CN");
    workspace.destroy();
  });

  it("ignores an unavailable desktop sidecar store without falling back to localStorage or blocking the paper", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const hash = "a".repeat(64);
    const storageKey = `paper2md-reader:visual-review:v2:${hash}`;
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        schema_version: 1,
        contract: "paper2md-user-visual-review",
        candidate_package_sha256: hash,
        decisions: []
      })),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 1
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    const loaded: LoadedPaperPackage = {
      state: "mineru",
      articlePath: "article.md",
      articleText: "# Paper\n\nVerified body remains readable.\n",
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
      diagnostics: [],
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      visualReview: {
        packageHash: hash,
        storageKey,
        candidates: [],
        blocks: [],
        decisions: []
      }
    };
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const read = vi.fn(async () => { throw new Error("library not configured or sidecar damaged"); });
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) },
      visualReviewStore: { read, write: vi.fn(async () => undefined) }
    });

    await workspace.attachFileSystem(new MemoryReaderFileSystem({ "article.md": loaded.articleText }));

    expect(read).toHaveBeenCalledWith(hash);
    expect(storage.getItem).not.toHaveBeenCalledWith(storageKey);
    expect(workspace.getReaderState().lifecycle).toBe("ready");
    expect(root.querySelector(".p2md-article")?.textContent).toContain("Verified body remains readable.");
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      level: "warning",
      code: "mineru-visual-review-file-store-unavailable"
    }));
    workspace.destroy();
  });

  it("fails closed when the desktop visual-review sidecar write is rejected", async () => {
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    const write = vi.fn(async () => { throw new Error("disk unavailable"); });
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "desktop", choosePackage: vi.fn(async () => undefined) },
      visualReviewStore: { read: vi.fn(async () => undefined), write }
    });
    const card = document.createElement("section");
    card.className = "p2md-review-card";
    const trigger = document.createElement("button");
    card.appendChild(trigger);
    root.appendChild(card);
    const hash = "a".repeat(64);
    const review: MinerUVisualReview = {
      packageHash: hash,
      storageKey: `paper2md-reader:visual-review:v2:${hash}`,
      candidates: [],
      blocks: [],
      decisions: []
    };
    const decision: MinerUVisualReviewDecision = {
      candidate_id: "candidate-1",
      verdict: "abstain",
      correction: null
    };

    await (workspace as unknown as {
      storeVisualReviewDecision(
        review: MinerUVisualReview,
        decision: MinerUVisualReviewDecision,
        trigger: HTMLElement
      ): Promise<void>;
    }).storeVisualReviewDecision(review, decision, trigger);

    expect(write).toHaveBeenCalledOnce();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(card.querySelector("[role=alert]")).not.toBeNull();
    workspace.destroy();
  });

  it("keeps Sites paper-derived view and visual-review state in the injected memory store", async () => {
    const pageSource = readFileSync(resolve(process.cwd(), "sites-reader/app/page.tsx"), "utf8");
    expect(pageSource).toMatch(/persistPaperState:\s*false/);
    const document = installDom();
    const root = document.querySelector<HTMLElement>("#reader")!;
    const browserStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: browserStorage });
    const values = new Map<string, string>();
    const paperStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
    };
    const packageHash = "a".repeat(64);
    const articleHash = "b".repeat(64);
    const reviewKey = `paper2md-reader:visual-review:v2:${packageHash}`;
    const viewKey = `paper2md-reader:view:v1:${articleHash}`;
    const loaded: LoadedPaperPackage = {
      state: "mineru",
      articlePath: "article.md",
      articleText: "# Paper\n\nEphemeral Sites state.\n",
      articleHash,
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
      sourceFormat: "mineru",
      packageIntegrity: "verified",
      visualReview: {
        packageHash,
        storageKey: reviewKey,
        candidates: [],
        blocks: [],
        decisions: []
      }
    };
    vi.spyOn(PackageLoader.prototype, "loadDetected").mockResolvedValue(loaded);
    const workspace = mountReaderWorkspace(root, {
      picker: { platform: "web", choosePackage: vi.fn(async () => undefined) },
      paperStateStorage: paperStorage
    });

    await workspace.attachFileSystem(new MemoryReaderFileSystem({ "article.md": loaded.articleText }));
    expect(paperStorage.getItem).toHaveBeenCalledWith(reviewKey);
    expect(paperStorage.getItem).toHaveBeenCalledWith(viewKey);
    expect(browserStorage.getItem).not.toHaveBeenCalledWith(reviewKey);
    expect(browserStorage.getItem).not.toHaveBeenCalledWith(viewKey);

    const card = document.createElement("section");
    card.className = "p2md-review-card";
    const trigger = document.createElement("button");
    card.appendChild(trigger);
    root.appendChild(card);
    const harness = workspace as unknown as {
      storeVisualReviewDecision(
        review: MinerUVisualReview,
        decision: MinerUVisualReviewDecision,
        trigger: HTMLElement
      ): Promise<void>;
      openDiagnostics(): void;
    };
    harness.openDiagnostics = vi.fn();
    await harness.storeVisualReviewDecision(loaded.visualReview!, {
      candidate_id: "candidate-1",
      verdict: "abstain",
      correction: null
    }, trigger);
    expect(paperStorage.setItem).toHaveBeenCalledWith(reviewKey, expect.any(String));
    expect(browserStorage.setItem).not.toHaveBeenCalledWith(reviewKey, expect.any(String));

    workspace.destroy();
    expect(paperStorage.setItem).toHaveBeenCalledWith(viewKey, expect.any(String));
    expect(browserStorage.setItem).not.toHaveBeenCalledWith(viewKey, expect.any(String));
  });
});
