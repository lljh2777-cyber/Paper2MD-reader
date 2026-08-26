import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { setReaderIcon } from "./icons";
import { readerText, ReaderLocale } from "../ui/locale";
import { PdfReaderState } from "../sync/pdf-reader-state";
import {
  largeCompatibilityImageBlocks,
  MinerUPdfLayout,
  sampledRegionLooksBlank
} from "../model/mineru-pdf-layout";

export interface PdfPageRenderResult {
  width: number;
  height: number;
}

export interface PdfReferenceRuntime {
  open(fileSystem: ReaderFileSystem, pdfPath: string): Promise<number>;
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    availableWidth: number,
    zoom: number
  ): Promise<PdfPageRenderResult>;
  cancelPageRender(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function iconButton(label: string, icon: string): HTMLButtonElement {
  const node = element("button", "p2md-pdf-icon-button");
  node.type = "button";
  node.ariaLabel = label;
  setReaderIcon(node, icon);
  return node;
}

function isAbortError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /AbortError|RenderingCancelled|cancelled|canceled|superseded/i.test(message);
}

export class PdfReferencePane {
  private readonly state = new PdfReaderState();
  private readonly toolbar: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageCount: HTMLElement;
  private readonly zoomValue: HTMLElement;
  private readonly followInput: HTMLInputElement;
  private readonly followLabel: HTMLElement;
  private readonly layoutButton: HTMLButtonElement;
  private wrappers: HTMLElement[] = [];
  private source?: { fileSystem: ReaderFileSystem; path: string };
  private layout?: MinerUPdfLayout;
  private showLayoutBoxes = true;
  private currentVisualId = "";
  private observer?: IntersectionObserver;
  private renderQueue = Promise.resolve();
  private generation = 0;
  private scrollFrame = 0;
  private visible = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly runtime: PdfReferenceRuntime,
    private readonly locale: ReaderLocale,
    private readonly onSelectVisual?: (visualId: string) => void
  ) {
    this.container.classList.add("p2md-pdf-pane");
    this.toolbar = element("header", "p2md-pdf-toolbar");
    this.previous = iconButton(readerText(locale, "previousPdfPage"), "chevron-left");
    this.pageInput = element("input", "p2md-pdf-page-input");
    this.pageInput.type = "number";
    this.pageInput.min = "1";
    this.pageInput.value = "1";
    this.pageInput.ariaLabel = readerText(locale, "pdfPage");
    this.pageCount = element("span", "p2md-pdf-page-count");
    this.next = iconButton(readerText(locale, "nextPdfPage"), "chevron-right");
    const divider = element("span", "p2md-pdf-toolbar-divider");
    const zoomOut = iconButton(readerText(locale, "zoomOutPdf"), "minus");
    this.zoomValue = element("span", "p2md-pdf-zoom-value");
    const zoomIn = iconButton(readerText(locale, "zoomInPdf"), "plus");
    const fit = element("button", "p2md-pdf-fit-button");
    fit.type = "button";
    fit.textContent = readerText(locale, "fitPdfWidth");
    this.layoutButton = element("button", "p2md-pdf-fit-button is-active");
    this.layoutButton.type = "button";
    this.layoutButton.textContent = readerText(locale, "pdfLayoutBoxes");
    this.layoutButton.setAttribute("aria-pressed", "true");
    const follow = element("label", "p2md-pdf-follow-control");
    this.followInput = element("input");
    this.followInput.type = "checkbox";
    this.followInput.checked = true;
    this.followInput.setAttribute("role", "switch");
    this.followInput.ariaLabel = readerText(locale, "followPdfPage");
    const followTrack = element("span", "p2md-follow-track");
    this.followLabel = element("span", "p2md-pdf-follow-label");
    follow.append(this.followInput, followTrack, this.followLabel);
    this.toolbar.append(this.previous, this.pageInput, this.pageCount, this.next, divider, zoomOut, this.zoomValue, zoomIn, fit, this.layoutButton, follow);
    this.scroll = element("div", "p2md-pdf-scroll");
    this.scroll.tabIndex = 0;
    this.scroll.ariaLabel = readerText(locale, "continuousPdf");
    this.container.replaceChildren(this.toolbar, this.scroll);

    const markPdfInteraction = () => {
      if (this.state.markPdfInteraction()) this.updateToolbar();
    };
    [this.toolbar, this.scroll].forEach((target) => {
      target.addEventListener("pointerdown", markPdfInteraction);
      target.addEventListener("focusin", markPdfInteraction);
    });
    this.scroll.addEventListener("pointerenter", markPdfInteraction);
    this.scroll.addEventListener("wheel", markPdfInteraction, { passive: true });
    this.scroll.addEventListener("touchstart", markPdfInteraction, { passive: true });
    this.previous.addEventListener("click", () => this.changePage(-1));
    this.next.addEventListener("click", () => this.changePage(1));
    this.pageInput.addEventListener("change", () => {
      this.state.setPage(Number(this.pageInput.value));
      this.updateToolbar();
      this.scrollToPage(this.state.currentPage, "smooth");
    });
    zoomOut.addEventListener("click", () => this.changeZoom(1 / 1.15));
    zoomIn.addEventListener("click", () => this.changeZoom(1.15));
    fit.addEventListener("click", () => {
      if (!this.state.setZoom(1)) return;
      this.rebuildPages();
    });
    this.layoutButton.addEventListener("click", () => {
      this.showLayoutBoxes = !this.showLayoutBoxes;
      this.layoutButton.classList.toggle("is-active", this.showLayoutBoxes);
      this.layoutButton.setAttribute("aria-pressed", String(this.showLayoutBoxes));
      this.refreshLayoutOverlays();
    });
    this.followInput.addEventListener("change", () => {
      const pageChanged = this.state.setFollowing(this.followInput.checked);
      this.updateToolbar();
      if (pageChanged) this.scrollToPage(this.state.currentPage, "smooth");
    });
    this.scroll.addEventListener("scroll", () => this.scheduleVisiblePageUpdate(), { passive: true });
    this.updateToolbar();
  }

  async setSource(fileSystem: ReaderFileSystem, path: string, layout?: MinerUPdfLayout): Promise<void> {
    this.clearPages();
    this.source = { fileSystem, path };
    this.layout = layout;
    const generation = ++this.generation;
    this.renderMessage(readerText(this.locale, "loadingPdf"));
    try {
      const count = await this.runtime.open(fileSystem, path);
      if (generation !== this.generation) return;
      if (!count) throw new Error(readerText(this.locale, "pdfHasNoPages"));
      this.state.setPageCount(count);
      this.updateToolbar();
      if (this.visible) this.rebuildPages();
      else this.scroll.replaceChildren();
    } catch (error) {
      if (generation !== this.generation || isAbortError(error)) return;
      this.renderMessage(
        `${readerText(this.locale, "pdfLoadFailed")}${error instanceof Error && error.message ? `: ${error.message}` : ""}`,
        true
      );
    }
  }

  clearSource(): void {
    this.generation += 1;
    this.source = undefined;
    this.layout = undefined;
    this.state.setPageCount(0);
    this.clearPages();
    this.renderMessage(readerText(this.locale, "noSourcePdf"));
    this.updateToolbar();
  }

  setVisible(value: boolean): void {
    this.visible = value;
    this.container.hidden = !value;
    if (value && this.source && this.state.pageCount && !this.wrappers.length) this.rebuildPages();
  }

  trackMarkdownPage(pageNumber: number): void {
    if (!this.state.trackMarkdownPage(pageNumber)) return;
    this.updateToolbar();
    if (this.visible) this.scrollToPage(this.state.currentPage, "auto");
  }

  activateMarkdownFollowing(): void {
    if (!this.state.markMarkdownInteraction()) return;
    this.updateToolbar();
    if (this.visible) this.scrollToPage(this.state.currentPage, "auto");
  }

  setCurrentVisual(id: string): void {
    this.currentVisualId = id;
    this.container.querySelectorAll<HTMLElement>(".p2md-pdf-layout-box").forEach((box) => {
      box.classList.toggle("is-current", Boolean(id) && box.dataset.visualId === id);
    });
  }

  destroy(): void {
    this.generation += 1;
    this.source = undefined;
    this.clearPages();
  }

  private rebuildPages(): void {
    if (!this.source || !this.visible || !this.state.pageCount) return;
    const currentPage = this.state.currentPage;
    this.clearPages();
    const generation = ++this.generation;
    const availableWidth = Math.max(260, this.scroll.clientWidth - 34);
    const estimatedWidth = Math.floor(availableWidth * this.state.zoom);
    for (let pageNumber = 1; pageNumber <= this.state.pageCount; pageNumber += 1) {
      const wrapper = element("section", "p2md-pdf-page is-loading");
      wrapper.dataset.pageNumber = String(pageNumber);
      wrapper.dataset.renderState = "idle";
      wrapper.style.width = `${estimatedWidth}px`;
      wrapper.setAttribute("aria-label", readerText(this.locale, "pdfPageNumber", { page: pageNumber }));
      const placeholder = element("div", "p2md-pdf-page-placeholder");
      placeholder.textContent = readerText(this.locale, "loadingPdfPage", { page: pageNumber });
      const canvas = element("canvas");
      canvas.hidden = true;
      canvas.setAttribute("aria-label", readerText(this.locale, "pdfPageContent", { page: pageNumber }));
      wrapper.append(placeholder, canvas);
      this.scroll.appendChild(wrapper);
      this.wrappers.push(wrapper);
    }
    this.observer = typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) this.queuePageRender(entry.target as HTMLElement, generation, availableWidth);
        });
      }, { root: this.scroll, rootMargin: "1400px 0px", threshold: 0.01 });
    if (this.observer) this.wrappers.forEach((wrapper) => this.observer?.observe(wrapper));
    else this.wrappers.forEach((wrapper) => this.queuePageRender(wrapper, generation, availableWidth));
    this.scrollToPage(currentPage, "auto");
    const current = this.wrappers[currentPage - 1];
    if (current) this.queuePageRender(current, generation, availableWidth);
    if (currentPage > 1) this.queuePageRender(this.wrappers[currentPage - 2], generation, availableWidth);
    if (currentPage < this.wrappers.length) this.queuePageRender(this.wrappers[currentPage], generation, availableWidth);
    this.updateToolbar();
  }

  private queuePageRender(wrapper: HTMLElement | undefined, generation: number, availableWidth: number): void {
    if (!wrapper || wrapper.dataset.renderState !== "idle") return;
    wrapper.dataset.renderState = "queued";
    this.renderQueue = this.renderQueue.then(async () => {
      if (generation !== this.generation || !wrapper.isConnected) return;
      const canvas = wrapper.querySelector<HTMLCanvasElement>("canvas");
      if (!canvas) return;
      const pageNumber = Number(wrapper.dataset.pageNumber || 1);
      wrapper.dataset.renderState = "rendering";
      try {
        let size = await this.runtime.renderPage(pageNumber, canvas, availableWidth, this.state.zoom);
        if (this.pageHasSuspiciousBlankVisual(pageNumber, canvas)) {
          wrapper.dataset.renderRetried = "true";
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          size = await this.runtime.renderPage(pageNumber, canvas, availableWidth, this.state.zoom);
        }
        if (generation !== this.generation || !wrapper.isConnected) return;
        wrapper.style.width = `${Math.floor(size.width)}px`;
        wrapper.style.height = `${Math.floor(size.height)}px`;
        const compatibilityImages = await this.paintPdfImageCompatibilityLayer(wrapper, pageNumber, generation);
        if (compatibilityImages) wrapper.dataset.imageFallback = String(compatibilityImages);
        wrapper.querySelector(".p2md-pdf-page-placeholder")?.remove();
        canvas.hidden = false;
        wrapper.classList.remove("is-loading", "is-error");
        wrapper.classList.add("is-rendered");
        wrapper.dataset.renderState = "rendered";
        if (this.showLayoutBoxes) this.renderPdfOverlays(wrapper, pageNumber);
      } catch (error) {
        if (generation !== this.generation || !wrapper.isConnected || isAbortError(error)) return;
        wrapper.dataset.renderState = "error";
        wrapper.classList.remove("is-loading");
        wrapper.classList.add("is-error");
        const placeholder = wrapper.querySelector<HTMLElement>(".p2md-pdf-page-placeholder");
        if (placeholder) placeholder.textContent = readerText(this.locale, "pdfPageLoadFailed", { page: pageNumber });
      }
    }).catch(() => undefined);
  }

  private clearPages(): void {
    this.runtime.cancelPageRender();
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    this.wrappers = [];
    this.scroll.replaceChildren();
    this.renderQueue = Promise.resolve();
  }

  private renderMessage(message: string, error = false): void {
    this.clearPages();
    const state = element("div", `p2md-pdf-empty${error ? " is-error" : ""}`);
    state.textContent = message;
    this.scroll.appendChild(state);
  }

  private changePage(delta: number): void {
    if (!this.state.changePage(delta)) return;
    this.updateToolbar();
    this.scrollToPage(this.state.currentPage, "smooth");
  }

  private changeZoom(factor: number): void {
    if (!this.state.changeZoom(factor)) return;
    this.rebuildPages();
  }

  private scrollToPage(pageNumber: number, behavior: ScrollBehavior): void {
    const page = this.wrappers[pageNumber - 1];
    if (!page) return;
    const inset = Number.parseFloat(getComputedStyle(this.scroll).paddingTop) || 0;
    const top = this.scroll.scrollTop + page.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top - inset;
    this.scroll.scrollTo({ top: Math.max(0, top), behavior });
  }

  private scheduleVisiblePageUpdate(): void {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      const probe = this.scroll.scrollTop + Math.min(this.scroll.clientHeight * 0.35, 260);
      const scrollRect = this.scroll.getBoundingClientRect();
      let current = 1;
      for (const wrapper of this.wrappers) {
        const top = this.scroll.scrollTop + wrapper.getBoundingClientRect().top - scrollRect.top;
        if (top > probe) break;
        current = Number(wrapper.dataset.pageNumber || current);
      }
      if (this.state.setPage(current)) this.updateToolbar();
    });
  }

  private updateToolbar(): void {
    const count = this.state.pageCount;
    this.pageInput.max = String(Math.max(1, count));
    this.pageInput.value = String(this.state.currentPage);
    this.pageInput.disabled = !count;
    this.pageCount.textContent = `/ ${count}`;
    this.previous.disabled = !count || this.state.currentPage <= 1;
    this.next.disabled = !count || this.state.currentPage >= count;
    this.zoomValue.textContent = `${Math.round(this.state.zoom * 100)}%`;
    this.followInput.checked = this.state.isFollowing;
    this.followInput.ariaLabel = readerText(this.locale, this.state.followPaused ? "followPdfPaused" : "followPdfPage");
    this.followLabel.textContent = readerText(this.locale, this.state.followPaused ? "followPdfPaused" : "followPdfPage");
    this.followLabel.title = this.state.followPaused
      ? readerText(this.locale, "followPdfPaused")
      : readerText(this.locale, "followPdfPage");
  }

  private pageHasSuspiciousBlankVisual(pageNumber: number, canvas: HTMLCanvasElement): boolean {
    const bounds = this.layout?.blocks.filter((block) => block.pageIndex === pageNumber - 1 && block.role === "visual") ?? [];
    if (!bounds.length || canvas.width < 1 || canvas.height < 1) return false;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return false;
    try {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return bounds.some((block) => sampledRegionLooksBlank(pixels, canvas.width, canvas.height, block.bbox));
    } catch {
      return false;
    }
  }

  private async paintPdfImageCompatibilityLayer(wrapper: HTMLElement, pageNumber: number, generation: number): Promise<number> {
    const source = this.source;
    const blocks = largeCompatibilityImageBlocks(this.layout, pageNumber);
    if (!source || !blocks.length) return 0;
    const layer = element("div", "p2md-pdf-image-layer");
    layer.setAttribute("aria-label", readerText(this.locale, "pdfImageCompatibility", { page: pageNumber }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
    if (generation !== this.generation || !wrapper.isConnected) return 0;
    let count = 0;
    for (const block of blocks) {
      if (!block.assetPath || !await source.fileSystem.exists(block.assetPath)) continue;
      let image: HTMLImageElement | undefined;
      try {
        image = element("img");
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        image.src = await source.fileSystem.resolveAssetUrl(block.assetPath);
        image.style.left = `${block.bbox.x * 100}%`;
        image.style.top = `${block.bbox.y * 100}%`;
        image.style.width = `${block.bbox.width * 100}%`;
        image.style.height = `${block.bbox.height * 100}%`;
        layer.appendChild(image);
        await image.decode();
        count += 1;
      } catch {
        image?.remove();
      }
    }
    if (!count) return 0;
    wrapper.querySelector(".p2md-pdf-image-layer")?.remove();
    wrapper.appendChild(layer);
    return count;
  }

  private refreshLayoutOverlays(): void {
    this.wrappers.forEach((wrapper) => {
      wrapper.querySelector(".p2md-pdf-overlay")?.remove();
      if (this.showLayoutBoxes && wrapper.dataset.renderState === "rendered") {
        this.renderPdfOverlays(wrapper, Number(wrapper.dataset.pageNumber || 1));
      }
    });
  }

  private renderPdfOverlays(wrapper: HTMLElement, pageNumber: number): void {
    const blocks = this.layout?.blocks.filter((block) => block.pageIndex === pageNumber - 1) ?? [];
    if (!blocks.length) return;
    wrapper.querySelector(".p2md-pdf-overlay")?.remove();
    const overlay = element("div", "p2md-pdf-overlay");
    for (const block of blocks) {
      const box = block.visualId
        ? element("button", `p2md-pdf-layout-box is-${block.role}`)
        : element("div", `p2md-pdf-layout-box is-${block.role}`);
      box.style.left = `${block.bbox.x * 100}%`;
      box.style.top = `${block.bbox.y * 100}%`;
      box.style.width = `${block.bbox.width * 100}%`;
      box.style.height = `${block.bbox.height * 100}%`;
      box.title = block.visualId ? readerText(this.locale, "locateVisual") : block.sourceType;
      if (block.visualId) {
        const button = box as HTMLButtonElement;
        button.type = "button";
        button.dataset.visualId = block.visualId;
        button.ariaLabel = readerText(this.locale, "locateVisual");
        button.classList.toggle("is-current", block.visualId === this.currentVisualId);
        button.addEventListener("click", () => this.onSelectVisual?.(block.visualId!));
      }
      overlay.appendChild(box);
    }
    wrapper.appendChild(overlay);
  }
}
