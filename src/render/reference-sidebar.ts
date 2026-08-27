import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { FigurePresentation, FigureSidebar, FigureSidebarOptions } from "./figure-sidebar";
import { PdfReferencePane, PdfReferenceRuntime } from "./pdf-reference-pane";
import { readerText, ReaderLocale } from "../ui/locale";
import { MinerUPdfLayout } from "../model/mineru-pdf-layout";
import { PdfReferencePaneState } from "./pdf-reference-pane";

export type ReferenceMode = "pdf" | "visuals";

export interface ReferenceSidebarState {
  mode: ReferenceMode;
  pdf: PdfReferencePaneState;
  selectedVisualId: string;
  visualFollowing: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class ReferenceSidebar {
  private readonly pdfTab: HTMLButtonElement;
  private readonly visualsTab: HTMLButtonElement;
  private readonly pdfHost: HTMLElement;
  private readonly visualsHost: HTMLElement;
  private readonly pdfPane?: PdfReferencePane;
  private readonly figures: FigureSidebar;
  private mode: ReferenceMode = "visuals";

  constructor(
    private readonly container: HTMLElement,
    figureOptions: FigureSidebarOptions,
    pdfRuntime: PdfReferenceRuntime | undefined,
    locale: ReaderLocale,
    private readonly onStateChange?: () => void
  ) {
    this.container.classList.add("p2md-reference-host");
    const tabs = element("header", "p2md-reference-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.ariaLabel = readerText(locale, "referenceViews");
    this.pdfTab = element("button", "p2md-reference-tab");
    this.pdfTab.type = "button";
    this.pdfTab.setAttribute("role", "tab");
    this.pdfTab.textContent = readerText(locale, "originalPdf");
    this.pdfTab.hidden = true;
    this.visualsTab = element("button", "p2md-reference-tab");
    this.visualsTab.type = "button";
    this.visualsTab.setAttribute("role", "tab");
    this.visualsTab.textContent = readerText(locale, "imagesAndCaptions");
    tabs.append(this.pdfTab, this.visualsTab);
    this.pdfHost = element("section", "p2md-reference-view p2md-reference-pdf");
    this.pdfHost.setAttribute("role", "tabpanel");
    this.visualsHost = element("section", "p2md-reference-view p2md-reference-visuals");
    this.visualsHost.setAttribute("role", "tabpanel");
    this.container.replaceChildren(tabs, this.pdfHost, this.visualsHost);
    this.figures = new FigureSidebar(this.visualsHost, {
      ...figureOptions,
      onSelectionChange: (figure, followingReading) => {
        this.pdfPane?.setCurrentVisual(figure.id);
        figureOptions.onSelectionChange?.(figure, followingReading);
      },
      onStateChange: () => this.onStateChange?.()
    });
    this.pdfPane = pdfRuntime ? new PdfReferencePane(this.pdfHost, pdfRuntime, locale, (visualId) => {
      this.pdfPane?.setCurrentVisual(visualId);
      this.figures.select(visualId, true);
      this.onStateChange?.();
    }, () => this.onStateChange?.()) : undefined;
    this.pdfTab.addEventListener("click", () => this.setMode("pdf"));
    this.visualsTab.addEventListener("click", () => this.setMode("visuals"));
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || this.pdfTab.hidden) return;
      event.preventDefault();
      const mode = event.key === "ArrowLeft" || event.key === "Home" ? "pdf" : "visuals";
      this.setMode(mode);
      (mode === "pdf" ? this.pdfTab : this.visualsTab).focus();
    });
    this.setMode("visuals", false);
  }

  async setPdfSource(source: { path: string } | undefined, fileSystem: ReaderFileSystem, layout?: MinerUPdfLayout): Promise<void> {
    const available = Boolean(source && this.pdfPane);
    this.pdfTab.hidden = !available;
    if (!available) {
      this.pdfPane?.clearSource();
      this.setMode("visuals");
      return;
    }
    await this.pdfPane!.setSource(fileSystem, source!.path, layout);
  }

  clearPdfSource(): void {
    this.pdfTab.hidden = true;
    this.pdfPane?.clearSource();
    this.setMode("visuals");
  }

  setFigures(figures: FigurePresentation[]): void {
    this.figures.setFigures(figures);
    this.pdfPane?.setCurrentVisual(figures[0]?.id ?? "");
  }

  trackReadingTarget(id: string): void {
    this.figures.trackReadingTarget(id);
    this.pdfPane?.setCurrentVisual(id);
  }

  activateReadingFollowing(): void {
    this.figures.activateReadingFollowing();
  }

  navigateTo(id: string): boolean {
    return this.figures.navigateTo(id);
  }

  trackMarkdownPage(pageNumber: number): void {
    this.pdfPane?.trackMarkdownPage(pageNumber);
  }

  activateMarkdownFollowing(): void {
    this.pdfPane?.activateMarkdownFollowing();
  }

  getState(): ReferenceSidebarState {
    const figure = this.figures.getState();
    return {
      mode: this.mode,
      pdf: this.pdfPane?.getState() ?? { page: 1, zoom: 1, following: true, showLayoutBoxes: true },
      selectedVisualId: figure.selectedVisualId,
      visualFollowing: figure.following
    };
  }

  restoreState(state: ReferenceSidebarState): void {
    this.figures.restoreState({ selectedVisualId: state.selectedVisualId, following: state.visualFollowing });
    this.pdfPane?.setCurrentVisual(state.selectedVisualId);
    this.pdfPane?.restoreState(state.pdf);
    this.setMode(state.mode, false);
  }

  setVisualFollowing(value: boolean): ReferenceSidebarState {
    this.figures.setFollowing(value);
    return this.getState();
  }

  setFollowing(value: boolean): ReferenceSidebarState {
    return this.setVisualFollowing(value);
  }

  setPdfFollowing(value: boolean): ReferenceSidebarState {
    this.pdfPane?.setFollowing(value);
    return this.getState();
  }

  destroy(): void {
    this.pdfPane?.destroy();
  }

  setMode(mode: ReferenceMode, notify = true): ReferenceMode {
    if (mode === "pdf" && this.pdfTab.hidden) mode = "visuals";
    this.mode = mode;
    const pdf = mode === "pdf";
    this.pdfTab.dataset.selected = String(pdf);
    this.pdfTab.setAttribute("aria-selected", String(pdf));
    this.pdfTab.tabIndex = pdf ? 0 : -1;
    this.visualsTab.dataset.selected = String(!pdf);
    this.visualsTab.setAttribute("aria-selected", String(!pdf));
    this.visualsTab.tabIndex = pdf ? -1 : 0;
    this.pdfHost.hidden = !pdf;
    this.visualsHost.hidden = pdf;
    this.pdfPane?.setVisible(pdf);
    if (notify) this.onStateChange?.();
    return this.mode;
  }
}
