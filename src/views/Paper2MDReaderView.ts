import { ItemView, Modal, Notice, setIcon, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ObsidianReaderFileSystem } from "../filesystem/obsidian-reader-file-system";
import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { assetDisplayLabel, LoadedPaperPackage } from "../model/reader-contract";
import { PackageLoader } from "../model/package-loader";
import { PackageLimitError } from "../model/package-limits";
import { bindContractAssets, renderArticle, RenderedArticle } from "../render/article-renderer";
import { renderLocalArticle } from "../render/local-article-renderer";
import { UnsafeMarkdownResourceError } from "../render/markdown-resource-policy";
import { FigurePresentation, FigureSidebar } from "../render/figure-sidebar";
import { ScrollController } from "../sync/scroll-controller";
import {
  getReaderLocale,
  readerText,
  ReaderLocale,
  setReaderLocale,
  subscribeReaderLocale
} from "../ui/locale";
import { statusCopy } from "../ui/status-copy";

export const PAPER2MD_READER_VIEW = "paper2md-reader-view";

interface Paper2MDReaderState extends Record<string, unknown> {
  articlePath?: string;
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class Paper2MDReaderView extends ItemView {
  private articlePath?: string;
  private articleScroll?: HTMLElement;
  private articleContent?: HTMLElement;
  private figureHost?: HTMLElement;
  private fileLabel?: HTMLElement;
  private statusLabel?: HTMLElement;
  private diagnosticsButton?: HTMLButtonElement;
  private sidebar?: FigureSidebar;
  private package?: LoadedPaperPackage;
  private fileSystem?: ReaderFileSystem;
  private contentFileSystem?: ReaderFileSystem;
  private readonly scrollController = new ScrollController();
  private locale: ReaderLocale = getReaderLocale();
  private stopLocaleSubscription?: () => void;
  private loadGeneration = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return PAPER2MD_READER_VIEW;
  }

  getDisplayText(): string {
    return this.articlePath ? `Paper2MD · ${this.articlePath.split("/").pop()}` : readerText(this.locale, "readerTitle");
  }

  getIcon(): string {
    return "book-open";
  }

  getState(): Paper2MDReaderState {
    return { articlePath: this.articlePath };
  }

  async setState(state: Paper2MDReaderState, result: ViewStateResult): Promise<void> {
    this.articlePath = typeof state.articlePath === "string" ? state.articlePath : undefined;
    await super.setState(state, result);
    if (this.articleContent) await this.loadCurrentArticle();
  }

  async onOpen(): Promise<void> {
    document.documentElement.lang = this.locale;
    this.renderShell();
    await this.loadCurrentArticle();
    this.stopLocaleSubscription = subscribeReaderLocale((locale) => {
      if (locale === this.locale) return;
      this.locale = locale;
      this.renderShell();
      void this.loadCurrentArticle();
    });
  }

  async onClose(): Promise<void> {
    this.loadGeneration += 1;
    this.scrollController.disconnect();
    this.disposeCurrentFileSystems();
    this.stopLocaleSubscription?.();
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.contentEl.addClass("p2md-reader-view");
    const reader = createElement("div", "p2md-reader");
    const toolbar = createElement("header", "p2md-toolbar");

    const leading = createElement("div", "p2md-toolbar-group");
    const closeButton = createElement("button", "p2md-icon-button");
    closeButton.type = "button";
    closeButton.ariaLabel = readerText(this.locale, "closeReader");
    setIcon(closeButton, "arrow-left");
    closeButton.addEventListener("click", () => this.leaf.detach());
    const title = createElement("strong", "p2md-view-title");
    title.textContent = readerText(this.locale, "readerTitle");
    leading.append(closeButton, title);

    this.fileLabel = createElement("div", "p2md-file-label");
    this.fileLabel.textContent = readerText(this.locale, "noArticle");

    const trailing = createElement("div", "p2md-toolbar-group p2md-toolbar-trailing");
    this.diagnosticsButton = createElement("button", "p2md-contract-status");
    this.diagnosticsButton.type = "button";
    this.diagnosticsButton.disabled = true;
    this.statusLabel = createElement("span");
    this.statusLabel.textContent = readerText(this.locale, "noPackage");
    this.diagnosticsButton.appendChild(this.statusLabel);
    this.diagnosticsButton.addEventListener("click", () => this.openDiagnostics());
    const languageSelect = createElement("select", "p2md-language-select");
    languageSelect.ariaLabel = readerText(this.locale, "language");
    const english = createElement("option");
    english.value = "en";
    english.textContent = readerText(this.locale, "english");
    const chinese = createElement("option");
    chinese.value = "zh-CN";
    chinese.textContent = readerText(this.locale, "chinese");
    languageSelect.append(english, chinese);
    languageSelect.value = this.locale;
    languageSelect.addEventListener("change", () => setReaderLocale(languageSelect.value as ReaderLocale));
    const refreshButton = createElement("button", "p2md-icon-button");
    refreshButton.type = "button";
    refreshButton.ariaLabel = readerText(this.locale, "reloadArticle");
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", () => void this.loadCurrentArticle());
    trailing.append(languageSelect, this.diagnosticsButton, refreshButton);

    toolbar.append(leading, this.fileLabel, trailing);

    const workspace = createElement("div", "p2md-reader-workspace");
    this.articleScroll = createElement("main", "p2md-article-scroll");
    this.articleContent = createElement("article", "p2md-article markdown-rendered");
    this.articleScroll.appendChild(this.articleContent);
    this.figureHost = createElement("aside", "p2md-figures-host");
    workspace.append(this.articleScroll, this.figureHost);
    reader.append(toolbar, workspace);
    this.contentEl.appendChild(reader);

    this.sidebar = new FigureSidebar(this.figureHost, {
      locale: this.locale,
      onOpenImage: (figure) => this.openLightbox(figure),
      onSelectionChange: (figure, followingReading) => {
        if (followingReading) figure.slotElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  private async loadCurrentArticle(): Promise<void> {
    const loadGeneration = ++this.loadGeneration;
    const isCurrentLoad = () => loadGeneration === this.loadGeneration;
    this.scrollController.disconnect();
    if (!this.articleContent || !this.articleScroll || !this.figureHost || !this.sidebar) return;
    this.disposeCurrentFileSystems();
    this.package = undefined;
    if (!this.articlePath) {
      this.renderEmptyState(readerText(this.locale, "openArticleInstruction"));
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(this.articlePath);
    if (!(file instanceof TFile)) {
      this.renderEmptyState(readerText(this.locale, "articleNotFound", { path: this.articlePath }));
      return;
    }

    this.articleContent.setAttribute("aria-busy", "true");
    let sourceFileSystem: ReaderFileSystem | undefined;
    let loaded: LoadedPaperPackage | undefined;
    let committed = false;
    const disposeLocalSession = () => {
      if (loaded?.contentFileSystem && loaded.contentFileSystem !== sourceFileSystem) {
        loaded.contentFileSystem.dispose();
      }
      sourceFileSystem?.dispose();
    };
    try {
      const separator = file.path.lastIndexOf("/");
      const packageRoot = separator >= 0 ? file.path.slice(0, separator) : "";
      const articleRelativePath = separator >= 0 ? file.path.slice(separator + 1) : file.path;
      sourceFileSystem = new ObsidianReaderFileSystem(this.app, packageRoot);
      loaded = await new PackageLoader(sourceFileSystem).load(articleRelativePath);
      if (!isCurrentLoad()) {
        disposeLocalSession();
        return;
      }
      const contentFileSystem = loaded.contentFileSystem ?? sourceFileSystem;

      const contractUsable = loaded.state === "valid" || loaded.state === "edited-with-anchors" || loaded.state === "recoverable" || loaded.state === "mineru";
      const stagedArticle = document.createElement("article");
      stagedArticle.className = this.articleContent.className;
      const rendered = loaded.contentFileSystem
        ? await renderLocalArticle(loaded.articleText, stagedArticle, contentFileSystem, contractUsable)
        : await renderArticle(this.app, loaded.articleText, stagedArticle, file.path, this, contentFileSystem, contractUsable);
      if (!isCurrentLoad()) {
        disposeLocalSession();
        return;
      }
      if (contractUsable) bindContractAssets(rendered, loaded.assets);
      const figures = await this.createFigurePresentations(loaded, rendered, contractUsable, contentFileSystem);
      if (!isCurrentLoad()) {
        disposeLocalSession();
        return;
      }

      this.fileSystem = sourceFileSystem;
      this.contentFileSystem = loaded.contentFileSystem;
      this.package = loaded;
      committed = true;
      this.fileLabel!.textContent = file.name;
      this.updateStatus(loaded);
      this.contentEl.toggleClass("p2md-contract-mode", contractUsable);
      this.articleContent.replaceChildren(...stagedArticle.childNodes);
      this.sidebar.setFigures(figures);
      this.connectScrollSync(loaded, rendered, contractUsable);
    } catch (error) {
      if (!isCurrentLoad()) {
        if (!committed) disposeLocalSession();
        return;
      }
      console.error("Paper2MD Reader failed to load", error);
      this.package = undefined;
      if (committed) this.disposeCurrentFileSystems();
      else disposeLocalSession();
      const message = error instanceof PackageLimitError || error instanceof UnsafeMarkdownResourceError
        ? error.message
        : readerText(this.locale, "articleLoadFailed");
      this.renderEmptyState(message);
      new Notice(readerText(this.locale, "articleLoadNotice"));
    } finally {
      if (isCurrentLoad()) this.articleContent.removeAttribute("aria-busy");
    }
  }

  private async createFigurePresentations(
    loaded: LoadedPaperPackage,
    rendered: RenderedArticle,
    contractUsable: boolean,
    contentFileSystem: ReaderFileSystem
  ): Promise<FigurePresentation[]> {
    return Promise.all(loaded.assets.map(async (asset) => {
      const slotId = contractUsable && asset.placement_block_id && rendered.slotElements.has(asset.placement_block_id)
        ? asset.placement_block_id
        : undefined;
      const imageSrc = asset.exists ? await contentFileSystem.resolveAssetUrl(asset.path) : "";
      return {
        id: asset.id,
        label: assetDisplayLabel(asset),
        kind: asset.kind,
        imageSrc,
        captionElement: asset.caption_block_id ? rendered.blockElements.get(asset.caption_block_id) : undefined,
        captionText: asset.captionText,
        pageIndex: asset.pageIndex,
        slotElement: slotId ? rendered.slotElements.get(slotId) : undefined,
        available: asset.exists && Boolean(imageSrc)
      };
    }));
  }

  private disposeCurrentFileSystems(): void {
    if (this.contentFileSystem && this.contentFileSystem !== this.fileSystem) {
      this.contentFileSystem.dispose();
    }
    this.contentFileSystem = undefined;
    this.fileSystem?.dispose();
    this.fileSystem = undefined;
  }

  private connectScrollSync(loaded: LoadedPaperPackage, rendered: RenderedArticle, contractUsable: boolean): void {
    if (!contractUsable || !this.articleScroll || !this.sidebar) return;
    const slotToAsset = new Map<string, string>();
    for (const asset of loaded.assets) {
      if (asset.placement_block_id) slotToAsset.set(asset.placement_block_id, asset.id);
    }
    loaded.contract?.relations
      .filter((relation) => relation.type === "places")
      .forEach((relation) => slotToAsset.set(relation.source_id, relation.target_id));
    this.scrollController.connect(this.articleScroll, rendered.slotElements, slotToAsset, (assetId) => this.sidebar?.trackReadingTarget(assetId));
  }

  private updateStatus(loaded: LoadedPaperPackage): void {
    const status = statusCopy(loaded.state, this.locale);
    this.statusLabel!.textContent = status.label;
    this.diagnosticsButton!.dataset.tone = status.tone;
    this.diagnosticsButton!.disabled = false;
    this.diagnosticsButton!.title = loaded.diagnostics[0]?.message ?? status.label;
  }

  private renderEmptyState(message: string): void {
    if (!this.articleContent || !this.sidebar) return;
    this.articleContent.empty();
    const empty = createElement("div", "p2md-reader-empty");
    const title = createElement("h2");
    title.textContent = readerText(this.locale, "readerTitle");
    const copy = createElement("p");
    copy.textContent = message;
    empty.append(title, copy);
    this.articleContent.appendChild(empty);
    this.sidebar.setFigures([]);
  }

  private openDiagnostics(): void {
    if (!this.package) return;
    new DiagnosticsModal(this.app, this.package, this.locale).open();
  }

  private openLightbox(figure: FigurePresentation): void {
    new FigureLightbox(this.app, figure).open();
  }
}

class DiagnosticsModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private readonly loaded: LoadedPaperPackage,
    private readonly locale: ReaderLocale
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("p2md-diagnostics");
    contentEl.createEl("h2", { text: readerText(this.locale, "readerDiagnostics") });
    const summary = contentEl.createDiv({ cls: "p2md-diagnostic-summary" });
    summary.createEl("strong", { text: statusCopy(this.loaded.state, this.locale).label });
    summary.createEl("span", { text: this.loaded.contractVersion ?? readerText(this.locale, "noReaderContract") });
    const list = contentEl.createEl("ul");
    for (const diagnostic of this.loaded.diagnostics) {
      const item = list.createEl("li", { text: diagnostic.message });
      item.dataset.level = diagnostic.level;
    }
    if (!this.loaded.diagnostics.length) list.createEl("li", { text: readerText(this.locale, "noContractProblems") });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class FigureLightbox extends Modal {
  constructor(app: import("obsidian").App, private readonly figure: FigurePresentation) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("p2md-lightbox-modal");
    this.contentEl.addClass("p2md-lightbox");
    const heading = this.contentEl.createEl("h2", { text: this.figure.label });
    heading.tabIndex = -1;
    const image = this.contentEl.createEl("img", { attr: { src: this.figure.imageSrc, alt: this.figure.label } });
    if (this.figure.captionElement) {
      this.contentEl.appendChild(this.figure.captionElement.cloneNode(true));
    } else if (this.figure.captionText) {
      this.contentEl.createEl("p", { cls: "p2md-figure-caption", text: this.figure.captionText });
    }
    requestAnimationFrame(() => heading.focus());
    image.addEventListener("dblclick", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
