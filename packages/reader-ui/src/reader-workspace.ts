import { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import { assetDisplayLabel, Diagnostic, LoadedAsset, LoadedPaperPackage } from "../../../src/model/reader-contract";
import { PackageLoader } from "../../../src/model/package-loader";
import { injectMinerUPageAnchors } from "../../../src/model/mineru-page-map";
import { PackageSourceNotFoundError } from "../../../src/model/package-source";
import { PackageLimitError } from "../../../src/model/package-limits";
import { MinerUPackageIntegrityError } from "../../../src/model/mineru-package-integrity";
import {
  createVisualReviewSidecar,
  MAX_VISUAL_REVIEW_SIDECAR_BYTES,
  type MinerUReviewVerdict,
  type MinerUVisualReview,
  type MinerUVisualReviewDecision,
  visualReviewSidecarByteLength
} from "../../../src/model/mineru-visual-review";
import { bindContractAssets } from "../../../src/render/contract-renderer";
import type { RenderedArticle } from "../../../src/render/contract-renderer";
import { FigurePresentation, FigureSidebar, FigureSidebarOptions } from "../../../src/render/figure-sidebar";
import type { PdfReferenceRuntime } from "../../../src/render/pdf-reference-pane";
import { ReferenceSidebar } from "../../../src/render/reference-sidebar";
import { materializeReaderPageOwnership } from "../../../src/render/page-ownership";
import { setReaderIcon } from "../../../src/render/icons";
import { renderLocalArticle } from "../../../src/render/local-article-renderer";
import { UnsafeMarkdownResourceError } from "../../../src/render/markdown-resource-policy";
import { ScrollController } from "../../../src/sync/scroll-controller";
import {
  DEFAULT_READER_VIEW_STATE,
  parseReaderViewState,
  ReaderPersistedViewState,
  readerViewStateKey
} from "../../../src/sync/reader-view-state";
import {
  getReaderLocale,
  readerText,
  ReaderLocale,
  setReaderLocale,
  subscribeReaderLocale
} from "../../../src/ui/locale";
import { statusCopy } from "../../../src/ui/status-copy";
import type { ReaderPackagePicker } from "../../reader-core/src/index";
import type { ReaderProcessingProgress } from "../../reader-core/src/index";

export interface ReaderWorkspaceOptions {
  picker: ReaderPackagePicker;
  visualResolver?: {
    resolve(asset: LoadedAsset, fileSystem: ReaderFileSystem): Promise<string>;
    recoverText?(
      articleText: string,
      recovery: NonNullable<LoadedPaperPackage["textRecovery"]>,
      fileSystem: ReaderFileSystem
    ): Promise<{
      articleText: string;
      diagnostics: Diagnostic[];
      captionUpdates?: Array<{
        visualId: string;
        captionText: string;
        captionStatus: "complete" | "partial";
      }>;
    }>;
    dispose(): void;
  };
  pdfRuntime?: PdfReferenceRuntime;
  /** Mount the linked figure browser outside the reader shell, such as in a desktop tab pane. */
  figureHost?: HTMLElement;
  title?: string;
  emptyTitle?: string;
  emptyCopy?: string;
  emptyNote?: string;
  openLabel?: string;
  toolbarOpenLabel?: string;
  emptyOpenLabel?: string;
  unselectedLabel?: string;
  localizedCopy?: Partial<Record<ReaderLocale, Partial<ReaderWorkspaceLocalizedCopy>>>;
}

export interface ReaderWorkspaceLocalizedCopy {
  title: string;
  emptyTitle: string;
  emptyCopy: string;
  emptyNote: string;
  toolbarOpenLabel: string;
  emptyOpenLabel: string;
  unselectedLabel: string;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label: string, className: string, icon?: string): HTMLButtonElement {
  const node = element("button", className);
  node.type = "button";
  node.ariaLabel = label;
  if (icon) setReaderIcon(node, icon);
  const copy = element("span");
  copy.textContent = label;
  node.appendChild(copy);
  return node;
}

export class ReaderWorkspace {
  private fileSystem?: ReaderFileSystem;
  private loaded?: LoadedPaperPackage;
  private articleScroll!: HTMLElement;
  private articleContent!: HTMLElement;
  private fileLabel!: HTMLElement;
  private statusButton!: HTMLButtonElement;
  private statusLabel!: HTMLElement;
  private reloadButton!: HTMLButtonElement;
  private figureSidebar!: Pick<FigureSidebar, "setFigures" | "trackReadingTarget">;
  private referenceSidebar?: ReferenceSidebar;
  private workspaceElement!: HTMLElement;
  private splitRatio = DEFAULT_READER_VIEW_STATE.splitRatio;
  private stateKey?: string;
  private stateSaveTimer = 0;
  private welcomeStatus?: HTMLElement;
  private readonly scrollController = new ScrollController();
  private locale: ReaderLocale = getReaderLocale();
  private readonly stopLocaleSubscription: () => void;

  constructor(private readonly root: HTMLElement, private readonly options: ReaderWorkspaceOptions) {
    if (typeof document !== "undefined") document.documentElement.lang = this.locale;
    this.renderShell();
    this.renderWelcome();
    this.stopLocaleSubscription = subscribeReaderLocale((locale) => this.applyLocale(locale));
  }

  destroy(): void {
    this.saveViewState();
    if (this.stateSaveTimer) window.clearTimeout(this.stateSaveTimer);
    this.scrollController.disconnect();
    this.referenceSidebar?.destroy();
    this.options.visualResolver?.dispose();
    this.fileSystem?.dispose();
    this.options.picker.dispose?.();
    this.stopLocaleSubscription();
    this.options.figureHost?.replaceChildren();
    this.root.replaceChildren();
  }

  private localizedCopy(key: keyof ReaderWorkspaceLocalizedCopy, fallback: Parameters<typeof readerText>[1]): string {
    const localized = this.options.localizedCopy?.[this.locale]?.[key];
    if (localized) return localized;
    const openFallback = key === "toolbarOpenLabel" || key === "emptyOpenLabel" ? this.options.openLabel : undefined;
    const legacy = this.locale === "en" ? this.options[key] ?? openFallback : undefined;
    return legacy ?? readerText(this.locale, fallback);
  }

  private applyLocale(locale: ReaderLocale): void {
    if (locale === this.locale) return;
    this.saveViewState();
    this.locale = locale;
    this.scrollController.disconnect();
    this.referenceSidebar?.destroy();
    this.referenceSidebar = undefined;
    this.renderShell();
    if (this.fileSystem) {
      this.fileLabel.textContent = this.fileSystem.rootLabel;
      this.reloadButton.disabled = false;
      void this.loadPackage();
    } else {
      this.renderWelcome();
    }
  }

  async attachFileSystem(fileSystem: ReaderFileSystem): Promise<void> {
    this.saveViewState();
    this.scrollController.disconnect();
    this.options.visualResolver?.dispose();
    this.fileSystem?.dispose();
    this.fileSystem = fileSystem;
    this.fileLabel.textContent = fileSystem.rootLabel;
    this.reloadButton.disabled = false;
    await this.loadPackage();
  }

  private renderShell(): void {
    this.root.className = `p2md-reader-view p2md-local-reader-view${this.options.figureHost ? " p2md-external-figures" : ""}`;
    const reader = element("div", "p2md-reader");
    const toolbar = element("header", "p2md-toolbar");
    const leading = element("div", "p2md-toolbar-group");
    const title = element("strong", "p2md-view-title");
    title.textContent = this.localizedCopy("title", "readerTitle");
    const chooseButton = button(this.localizedCopy("toolbarOpenLabel", "openFolder"), "p2md-local-folder-button", "folder");
    chooseButton.addEventListener("click", () => void this.choosePackage());
    leading.append(title, chooseButton);

    this.fileLabel = element("div", "p2md-file-label");
    this.fileLabel.textContent = this.localizedCopy("unselectedLabel", "noPackageSelected");
    const trailing = element("div", "p2md-toolbar-group p2md-toolbar-trailing");
    const languageSelect = element("select", "p2md-language-select");
    languageSelect.ariaLabel = readerText(this.locale, "language");
    const english = element("option");
    english.value = "en";
    english.textContent = readerText(this.locale, "english");
    const chinese = element("option");
    chinese.value = "zh-CN";
    chinese.textContent = readerText(this.locale, "chinese");
    languageSelect.append(english, chinese);
    languageSelect.value = this.locale;
    languageSelect.addEventListener("change", () => setReaderLocale(languageSelect.value as ReaderLocale));
    this.statusButton = element("button", "p2md-contract-status");
    this.statusButton.type = "button";
    this.statusButton.disabled = true;
    this.statusLabel = element("span");
    this.statusLabel.textContent = readerText(this.locale, "noPackage");
    this.statusButton.appendChild(this.statusLabel);
    this.statusButton.addEventListener("click", () => this.openDiagnostics());
    this.reloadButton = element("button", "p2md-icon-button");
    this.reloadButton.type = "button";
    this.reloadButton.ariaLabel = readerText(this.locale, "reloadPackage");
    this.reloadButton.disabled = true;
    setReaderIcon(this.reloadButton, "refresh");
    this.reloadButton.addEventListener("click", () => void this.loadPackage());
    trailing.append(languageSelect, this.statusButton, this.reloadButton);
    toolbar.append(leading, this.fileLabel, trailing);

    const workspace = element(
      "div",
      `p2md-reader-workspace${this.options.figureHost ? " p2md-reader-workspace-external-figures" : ""}`
    );
    this.workspaceElement = workspace;
    this.applySplitRatio(this.splitRatio);
    this.articleScroll = element("main", "p2md-article-scroll");
    this.articleContent = element("article", "p2md-article markdown-rendered");
    this.articleScroll.appendChild(this.articleContent);
    const activateMarkdownFollowing = () => this.referenceSidebar?.activateMarkdownFollowing();
    this.articleScroll.addEventListener("pointerenter", activateMarkdownFollowing);
    this.articleScroll.addEventListener("pointerdown", activateMarkdownFollowing);
    this.articleScroll.addEventListener("wheel", activateMarkdownFollowing, { passive: true });
    this.articleScroll.addEventListener("focusin", activateMarkdownFollowing);
    this.articleScroll.addEventListener("scroll", () => this.scheduleViewStateSave(), { passive: true });
    const figureHost = this.options.figureHost ?? element("aside", "p2md-figures-host");
    workspace.appendChild(this.articleScroll);
    if (!this.options.figureHost) {
      workspace.append(this.createSplitter(), figureHost);
    }
    reader.append(toolbar, workspace);
    this.root.replaceChildren(reader);

    const figureOptions: FigureSidebarOptions = {
      locale: this.locale,
      onOpenImage: (figure) => this.openLightbox(figure),
      onSelectionChange: (figure, followingReading) => {
        if (followingReading) figure.slotElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    if (this.options.figureHost) {
      this.referenceSidebar = undefined;
      this.figureSidebar = new FigureSidebar(figureHost, figureOptions);
    } else {
      this.referenceSidebar = new ReferenceSidebar(
        figureHost,
        figureOptions,
        this.options.pdfRuntime,
        this.locale,
        () => this.scheduleViewStateSave()
      );
      this.figureSidebar = this.referenceSidebar;
    }
  }

  private async choosePackage(): Promise<void> {
    try {
      const fileSystem = await this.options.picker.choosePackage();
      if (fileSystem) await this.attachFileSystem(fileSystem);
    } catch (error) {
      console.error("Could not open Paper2MD package", error);
      this.renderFailure(readerText(this.locale, "selectedPackageOpenFailed"));
    }
  }

  private async loadPackage(): Promise<void> {
    if (!this.fileSystem) return;
    if (this.loaded) this.saveViewState();
    this.scrollController.disconnect();
    this.articleContent.setAttribute("aria-busy", "true");
    this.statusButton.disabled = true;
    this.statusLabel.textContent = readerText(this.locale, "loading");
    this.root.dataset.state = "loading";
    try {
      const loader = new PackageLoader(this.fileSystem);
      let loaded = await loader.loadDetected();
      const storedSidecar = this.readVisualReviewSidecar(loaded);
      if (storedSidecar !== undefined) loaded = await loader.loadDetected(storedSidecar);
      this.loaded = loaded;
      this.stateKey = loaded.articleHash ? readerViewStateKey(loaded.articleHash) : undefined;
      const restoredState = this.loadViewState();
      this.splitRatio = restoredState.splitRatio;
      this.applySplitRatio(this.splitRatio);
      const contractUsable = loaded.state === "valid" || loaded.state === "edited-with-anchors" || loaded.state === "recoverable" || loaded.state === "mineru" || loaded.state === "markdown";
      this.root.classList.toggle("p2md-contract-mode", contractUsable);
      let articleText = loaded.articleText;
      if (
        loaded.textRecovery
        && (
          loaded.textRecovery.candidates.length
          || loaded.textRecovery.captionContinuations?.length
          || loaded.textRecovery.paragraphRecoveries?.length
        )
        && this.options.visualResolver?.recoverText
      ) {
        const recovered = await this.options.visualResolver.recoverText(articleText, loaded.textRecovery, this.fileSystem);
        articleText = recovered.articleText;
        loaded.diagnostics.push(...recovered.diagnostics);
        recovered.captionUpdates?.forEach((update) => {
          const asset = loaded.assets.find((candidate) => candidate.id === update.visualId);
          if (!asset) return;
          asset.captionText = update.captionText;
          asset.captionStatus = update.captionStatus;
        });
      }
      articleText = injectMinerUPageAnchors(articleText, loaded.pageMap);
      this.updateStatus(loaded);
      const rendered = await renderLocalArticle(articleText, this.articleContent, this.fileSystem, contractUsable);
      const pageBlocks = loaded.pageMap ? materializeReaderPageOwnership(this.articleContent) : [];
      if (contractUsable) bindContractAssets(rendered, loaded.assets);
      this.figureSidebar.setFigures(await this.createFigurePresentations(loaded, rendered, contractUsable));
      if (this.referenceSidebar) await this.referenceSidebar.setPdfSource(loaded.sourcePdf, this.fileSystem, loaded.pdfLayout);
      this.referenceSidebar?.restoreState({
        mode: restoredState.referenceMode,
        pdf: {
          page: restoredState.pdfPage,
          zoom: restoredState.pdfZoom,
          following: restoredState.pdfFollowing,
          showLayoutBoxes: restoredState.showLayoutBoxes
        },
        selectedVisualId: restoredState.selectedVisualId,
        visualFollowing: restoredState.visualFollowing
      });
      this.connectScrollSync(loaded, rendered, pageBlocks, contractUsable);
      this.root.dataset.state = contractUsable ? "ready" : "degraded";
      this.articleScroll.scrollTop = restoredState.articleScrollTop;
    } catch (error) {
      console.error("Paper2MD Reader failed to load", error);
      this.loaded = undefined;
      const message = error instanceof PackageSourceNotFoundError
        ? readerText(this.locale, "noReadablePackage")
        : error instanceof PackageLimitError || error instanceof MinerUPackageIntegrityError || error instanceof UnsafeMarkdownResourceError
        ? error.message
        : readerText(this.locale, "packageLoadFailed");
      this.renderFailure(message);
    } finally {
      this.articleContent.removeAttribute("aria-busy");
    }
  }

  private async createFigurePresentations(loaded: LoadedPaperPackage, rendered: RenderedArticle, contractUsable: boolean): Promise<FigurePresentation[]> {
    return Promise.all(loaded.assets.map(async (asset) => {
      const slotId = contractUsable && asset.placement_block_id && rendered.slotElements.has(asset.placement_block_id)
        ? asset.placement_block_id
        : undefined;
      let imageSrc = "";
      if (asset.exists && this.fileSystem) {
        try {
          imageSrc = this.options.visualResolver
            ? await this.options.visualResolver.resolve(asset, this.fileSystem)
            : await this.fileSystem.resolveAssetUrl(asset.path);
        } catch {
          imageSrc = "";
        }
      }
      return {
        id: asset.id,
        label: assetDisplayLabel(asset),
        kind: asset.kind,
        imageSrc,
        captionElement: asset.caption_block_id ? rendered.blockElements.get(asset.caption_block_id) : undefined,
        captionText: asset.captionText,
        pageIndex: asset.pageIndex,
        captionPageIndex: asset.captionPageIndex,
        captionStatus: asset.captionStatus,
        slotElement: slotId ? rendered.slotElements.get(slotId) : undefined,
        available: asset.exists && Boolean(imageSrc)
      };
    }));
  }

  private connectScrollSync(
    loaded: LoadedPaperPackage,
    rendered: RenderedArticle,
    pageBlocks: HTMLElement[],
    contractUsable: boolean
  ): void {
    if (!contractUsable) return;
    const slotToAsset = new Map<string, string>();
    loaded.assets.forEach((asset) => {
      if (asset.placement_block_id) slotToAsset.set(asset.placement_block_id, asset.id);
    });
    loaded.contract?.relations
      .filter((relation) => relation.type === "places")
      .forEach((relation) => slotToAsset.set(relation.source_id, relation.target_id));
    this.scrollController.connect(this.articleScroll, rendered.slotElements, slotToAsset, (assetId) => {
      this.figureSidebar.trackReadingTarget(assetId);
    });
    this.scrollController.connectPages(this.articleScroll, pageBlocks, (pageNumber) => {
      this.referenceSidebar?.trackMarkdownPage(pageNumber);
    });
  }

  private updateStatus(loaded: LoadedPaperPackage): void {
    const status = loaded.state === "mineru" && loaded.packageIntegrity
      ? {
        label: readerText(this.locale, loaded.packageIntegrity === "verified" ? "statusMineruVerified" : "statusMineruUnverified"),
        tone: loaded.packageIntegrity === "verified" ? "ok" : "warning"
      }
      : statusCopy(loaded.state, this.locale);
    this.statusLabel.textContent = status.label;
    this.statusButton.dataset.tone = status.tone;
    this.statusButton.disabled = false;
    this.statusButton.title = loaded.diagnostics[0]?.message ?? status.label;
  }

  private createSplitter(): HTMLElement {
    const splitter = element("div", "p2md-reader-splitter");
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.ariaLabel = readerText(this.locale, "resizeReaderColumns");
    splitter.tabIndex = 0;
    const grip = element("span", "p2md-reader-splitter-grip");
    splitter.appendChild(grip);
    const update = (clientX: number) => {
      const rect = this.workspaceElement.getBoundingClientRect();
      if (!rect.width) return;
      this.splitRatio = Math.max(0.42, Math.min(0.78, (clientX - rect.left) / rect.width));
      this.applySplitRatio(this.splitRatio);
    };
    splitter.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      splitter.classList.add("is-dragging");
      const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
      const stop = () => {
        document.removeEventListener("pointermove", move);
        splitter.classList.remove("is-dragging");
        this.scheduleViewStateSave();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop, { once: true });
    });
    splitter.addEventListener("keydown", (event) => {
      if (!event.key.startsWith("Arrow") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      this.splitRatio = Math.max(0.42, Math.min(0.78, this.splitRatio + (event.key === "ArrowLeft" ? -0.02 : 0.02)));
      this.applySplitRatio(this.splitRatio);
      this.scheduleViewStateSave();
    });
    return splitter;
  }

  private applySplitRatio(value: number): void {
    this.workspaceElement?.style.setProperty("--p2md-article-width", `${value * 100}%`);
  }

  private loadViewState(): ReaderPersistedViewState {
    if (!this.stateKey) return { ...DEFAULT_READER_VIEW_STATE };
    try {
      return parseReaderViewState(window.localStorage.getItem(this.stateKey));
    } catch {
      return { ...DEFAULT_READER_VIEW_STATE };
    }
  }

  private scheduleViewStateSave(): void {
    if (!this.stateKey) return;
    if (this.stateSaveTimer) window.clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = window.setTimeout(() => {
      this.stateSaveTimer = 0;
      this.saveViewState();
    }, 180);
  }

  private saveViewState(): void {
    if (!this.stateKey || !this.articleScroll) return;
    const reference = this.referenceSidebar?.getState();
    const state: ReaderPersistedViewState = {
      version: 1,
      splitRatio: this.splitRatio,
      articleScrollTop: this.articleScroll.scrollTop,
      referenceMode: reference?.mode ?? "visuals",
      pdfPage: reference?.pdf.page ?? 1,
      pdfZoom: reference?.pdf.zoom ?? 1,
      pdfFollowing: reference?.pdf.following ?? true,
      showLayoutBoxes: reference?.pdf.showLayoutBoxes ?? true,
      selectedVisualId: reference?.selectedVisualId ?? "",
      visualFollowing: reference?.visualFollowing ?? true
    };
    try {
      window.localStorage.setItem(this.stateKey, JSON.stringify(state));
    } catch {
      // Storage can be unavailable in hardened or private browser contexts.
    }
  }

  private renderWelcome(): void {
    this.root.dataset.state = "idle";
    this.articleContent.replaceChildren();
    const empty = element("div", "p2md-reader-empty p2md-local-welcome");
    const title = element("h1");
    title.textContent = this.localizedCopy("emptyTitle", "readPackage");
    const copy = element("p");
    copy.textContent = this.localizedCopy("emptyCopy", "choosePackageCopy");
    const openButton = button(this.localizedCopy("emptyOpenLabel", "openPaperFolder"), "p2md-local-primary-button", "folder");
    openButton.addEventListener("click", () => void this.choosePackage());
    const actions = element("div", "p2md-local-welcome-actions");
    actions.appendChild(openButton);
    if (this.options.picker.choosePdfPackage) {
      const pdfButton = button(readerText(this.locale, "processPdfFile"), "p2md-local-secondary-button", "upload");
      pdfButton.addEventListener("click", () => void this.choosePdfPackage(pdfButton));
      actions.appendChild(pdfButton);
    }
    if (this.options.picker.chooseMarkdownDocument) {
      const markdownButton = button(readerText(this.locale, "openMarkdownFile"), "p2md-local-secondary-button", "document");
      markdownButton.addEventListener("click", () => void this.chooseMarkdownDocument());
      actions.appendChild(markdownButton);
    }
    if (this.options.picker.chooseWebClipping) {
      const clippingButton = button(readerText(this.locale, "openWebClipping"), "p2md-local-secondary-button", "document");
      clippingButton.addEventListener("click", () => void this.chooseWebClipping());
      actions.appendChild(clippingButton);
    }
    const note = element("small");
    note.textContent = this.localizedCopy("emptyNote", "contractValidatedNote");
    this.welcomeStatus = element("div", "p2md-local-processing-status");
    this.welcomeStatus.hidden = true;
    this.welcomeStatus.setAttribute("role", "status");
    empty.append(title, copy, actions, this.welcomeStatus, note);
    this.articleContent.appendChild(empty);
    this.figureSidebar.setFigures([]);
    this.referenceSidebar?.clearPdfSource();
  }

  private async chooseMarkdownDocument(): Promise<void> {
    try {
      const fileSystem = await this.options.picker.chooseMarkdownDocument?.();
      if (fileSystem) await this.attachFileSystem(fileSystem);
    } catch (error) {
      console.error("Could not open Markdown document", error);
      this.renderFailure(readerText(this.locale, "selectedMarkdownOpenFailed"));
    }
  }

  private async chooseWebClipping(): Promise<void> {
    try {
      const fileSystem = await this.options.picker.chooseWebClipping?.();
      if (fileSystem) await this.attachFileSystem(fileSystem);
    } catch (error) {
      console.error("Could not open web clipping", error);
      this.renderFailure(readerText(this.locale, "selectedWebClippingOpenFailed"));
    }
  }

  private async choosePdfPackage(trigger: HTMLButtonElement): Promise<void> {
    const choosePdfPackage = this.options.picker.choosePdfPackage;
    if (!choosePdfPackage) return;
    trigger.disabled = true;
    const updateProgress = (progress: ReaderProcessingProgress) => {
      if (!this.welcomeStatus) return;
      this.welcomeStatus.hidden = false;
      this.welcomeStatus.dataset.state = progress.state;
      this.welcomeStatus.textContent = progress.message || readerText(this.locale, "processingPdf");
    };
    try {
      const fileSystem = await choosePdfPackage(updateProgress);
      if (fileSystem) await this.attachFileSystem(fileSystem);
    } catch (error) {
      console.error("Could not process PDF", error);
      this.renderFailure(error instanceof Error && error.message
        ? error.message
        : readerText(this.locale, "selectedPdfOpenFailed"));
    } finally {
      trigger.disabled = false;
    }
  }

  private renderFailure(message: string): void {
    this.root.dataset.state = "error";
    this.root.classList.remove("p2md-contract-mode");
    this.articleContent.replaceChildren();
    const empty = element("div", "p2md-reader-empty p2md-local-error");
    const title = element("h2");
    title.textContent = readerText(this.locale, "unableOpenPackage");
    const copy = element("p");
    copy.textContent = message;
    const chooseButton = button(readerText(this.locale, "chooseAnotherFolder"), "p2md-local-primary-button", "folder");
    chooseButton.addEventListener("click", () => void this.choosePackage());
    empty.append(title, copy, chooseButton);
    this.articleContent.appendChild(empty);
    this.figureSidebar.setFigures([]);
    this.referenceSidebar?.clearPdfSource();
    this.statusLabel.textContent = readerText(this.locale, "loadFailed");
    this.statusButton.dataset.tone = "error";
    this.statusButton.disabled = true;
  }

  private readVisualReviewSidecar(loaded: LoadedPaperPackage): unknown | undefined {
    const review = loaded.visualReview;
    if (!review) return undefined;
    try {
      const raw = window.localStorage.getItem(review.storageKey);
      if (raw === null) return undefined;
      if (new TextEncoder().encode(raw).byteLength > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
        loaded.diagnostics.push({
          level: "warning",
          code: "mineru-visual-review-storage-oversized",
          message: "浏览器中的视觉审阅记录超过 64 KiB 安全上限，已忽略。"
        });
        return undefined;
      }
      return JSON.parse(raw) as unknown;
    } catch {
      loaded.diagnostics.push({
        level: "warning",
        code: "mineru-visual-review-storage-invalid",
        message: "浏览器中的视觉审阅记录不是有效 JSON，已忽略。"
      });
      return undefined;
    }
  }

  private async storeVisualReviewDecision(
    review: MinerUVisualReview,
    decision: MinerUVisualReviewDecision,
    trigger: HTMLElement
  ): Promise<void> {
    const decisions = new Map(review.decisions.map((item) => [item.candidate_id, item]));
    decisions.set(decision.candidate_id, decision);
    const sidecar = createVisualReviewSidecar(review.packageHash, [...decisions.values()]);
    try {
      const serialized = JSON.stringify(sidecar);
      if (visualReviewSidecarByteLength(sidecar) > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
        throw new Error("Visual review sidecar exceeds 64 KiB");
      }
      window.localStorage.setItem(review.storageKey, serialized);
    } catch {
      const message = element("p", "p2md-review-error");
      message.setAttribute("role", "alert");
      message.textContent = readerText(this.locale, "reviewStorageFailed");
      trigger.closest(".p2md-review-card")?.appendChild(message);
      return;
    }
    trigger.closest("dialog")?.close();
    await this.loadPackage();
    this.openDiagnostics();
  }

  private reviewDecisionLabel(decision: MinerUVisualReviewDecision | undefined): string | undefined {
    if (!decision) return undefined;
    if (decision.correction) return readerText(this.locale, "reviewDecisionCorrected");
    if (decision.verdict === "accept") return readerText(this.locale, "reviewDecisionAccept");
    if (decision.verdict === "reject") return readerText(this.locale, "reviewDecisionReject");
    return readerText(this.locale, "reviewDecisionAbstain");
  }

  private createVisualReviewSection(review: MinerUVisualReview): HTMLElement {
    const section = element("section", "p2md-visual-review");
    const heading = element("h3");
    heading.textContent = readerText(this.locale, "visualReviewTitle");
    const intro = element("p", "p2md-review-intro");
    intro.textContent = readerText(this.locale, "visualReviewIntro");
    section.append(heading, intro);
    if (!review.candidates.length) {
      const empty = element("p", "p2md-review-empty");
      empty.textContent = readerText(this.locale, "visualReviewNone");
      section.appendChild(empty);
      return section;
    }
    const decisions = new Map(review.decisions.map((item) => [item.candidate_id, item]));
    review.candidates.forEach((candidate) => {
      const card = element("article", "p2md-review-card");
      const cardHeader = element("div", "p2md-review-card-header");
      const title = element("strong");
      title.textContent = readerText(this.locale, candidate.kind === "fragment_group" ? "fragmentCandidate" : "captionCandidate");
      const meta = element("span");
      meta.textContent = readerText(this.locale, "reviewCandidatePage", {
        page: candidate.pageIndex + 1,
        count: candidate.memberBlockIds.length
      });
      cardHeader.append(title, meta);
      const existing = decisions.get(candidate.id);
      const decisionLabel = this.reviewDecisionLabel(existing);
      if (decisionLabel) {
        const badge = element("span", "p2md-review-decision");
        badge.dataset.verdict = existing?.verdict ?? "abstain";
        badge.textContent = decisionLabel;
        cardHeader.appendChild(badge);
      }
      const actions = element("div", "p2md-review-actions");
      const saveVerdict = (verdict: MinerUReviewVerdict) => (event: MouseEvent) => {
        void this.storeVisualReviewDecision(review, { candidate_id: candidate.id, verdict, correction: null }, event.currentTarget as HTMLElement);
      };
      const accept = button(readerText(this.locale, "acceptCandidate"), "p2md-review-button p2md-review-primary");
      const canAccept = candidate.kind === "cross_page_caption"
        ? Boolean(candidate.visualBlockId && candidate.captionBlockIds?.length)
        : candidate.replacementMode !== "none";
      accept.disabled = !canAccept;
      if (!canAccept) accept.title = readerText(this.locale, "reviewUnsupportedAccept");
      accept.addEventListener("click", saveVerdict("accept"));
      const reject = button(readerText(this.locale, "rejectCandidate"), "p2md-review-button");
      reject.addEventListener("click", saveVerdict("reject"));
      const abstain = button(readerText(this.locale, "abstainCandidate"), "p2md-review-button");
      abstain.addEventListener("click", saveVerdict("abstain"));
      actions.append(accept, reject, abstain);
      card.append(cardHeader, actions);

      if (candidate.kind === "fragment_group") {
        const details = element("details", "p2md-review-correction");
        const summary = element("summary");
        summary.textContent = readerText(this.locale, "specifyCorrectGroup");
        const help = element("p");
        help.textContent = readerText(this.locale, "correctionHelp");
        const choices = element("div", "p2md-review-blocks");
        const selectedIds = new Set(existing?.correction?.kind === "fragment_group"
          ? existing.correction.member_block_ids
          : candidate.memberBlockIds);
        review.blocks.filter((block) => block.pageIndex === candidate.pageIndex && block.role === "visual").forEach((block) => {
          const label = element("label", "p2md-review-block");
          const checkbox = element("input");
          checkbox.type = "checkbox";
          checkbox.value = block.id;
          checkbox.checked = selectedIds.has(block.id);
          const preview = element("span", "p2md-review-block-preview");
          if (block.assetPath && this.fileSystem) {
            const image = element("img");
            image.alt = "";
            void this.fileSystem.resolveAssetUrl(block.assetPath).then((url) => { image.src = url; }).catch(() => undefined);
            preview.appendChild(image);
          }
          const copy = element("span");
          copy.textContent = `${readerText(this.locale, "visualBlockLabel", { order: block.pageOrder + 1 })} · ${(block.bbox.x * 100).toFixed(0)}%, ${(block.bbox.y * 100).toFixed(0)}%`;
          label.append(checkbox, preview, copy);
          choices.appendChild(label);
        });
        const submit = button(readerText(this.locale, "submitCorrectGroup"), "p2md-review-button p2md-review-primary");
        submit.addEventListener("click", (event) => {
          const memberIds = [...choices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((input) => input.value);
          void this.storeVisualReviewDecision(review, {
            candidate_id: candidate.id,
            verdict: "reject",
            correction: { kind: "fragment_group", member_block_ids: memberIds }
          }, event.currentTarget as HTMLElement);
        });
        details.append(summary, help, choices, submit);
        card.appendChild(details);
      } else {
        const details = element("details", "p2md-review-correction");
        const summary = element("summary");
        summary.textContent = readerText(this.locale, "specifyCorrectCaptionLink");
        const help = element("p");
        help.textContent = readerText(this.locale, "captionCorrectionHelp");
        const correction = existing?.correction?.kind === "cross_page_caption" ? existing.correction : undefined;

        const sourceHeading = element("strong", "p2md-review-field-title");
        sourceHeading.textContent = readerText(this.locale, "captionSourceVisual");
        const sourceChoices = element("div", "p2md-review-blocks");
        const sourceName = `caption-source-${candidate.id}`;
        review.blocks.filter((block) => block.pageIndex === candidate.pageIndex && block.role === "visual").forEach((block) => {
          const label = element("label", "p2md-review-block");
          const radio = element("input");
          radio.type = "radio";
          radio.name = sourceName;
          radio.value = block.id;
          radio.checked = (correction?.visual_block_id ?? candidate.visualBlockId) === block.id;
          const preview = element("span", "p2md-review-block-preview");
          if (block.assetPath && this.fileSystem) {
            const image = element("img");
            image.alt = "";
            void this.fileSystem.resolveAssetUrl(block.assetPath).then((url) => { image.src = url; }).catch(() => undefined);
            preview.appendChild(image);
          }
          const copy = element("span");
          copy.textContent = `${readerText(this.locale, "visualBlockLabel", { order: block.pageOrder + 1 })} · ${(block.bbox.x * 100).toFixed(0)}%, ${(block.bbox.y * 100).toFixed(0)}%`;
          label.append(radio, preview, copy);
          sourceChoices.appendChild(label);
        });

        const captionHeading = element("strong", "p2md-review-field-title");
        captionHeading.textContent = readerText(this.locale, "captionTargetBlocks", { page: (candidate.targetPageIndex ?? candidate.pageIndex + 1) + 1 });
        const captionChoices = element("div", "p2md-review-caption-blocks");
        const selectedCaptionIds = new Set(correction?.caption_block_ids ?? candidate.captionBlockIds ?? []);
        review.blocks.filter((block) => block.pageIndex === candidate.targetPageIndex && (block.role === "text" || block.role === "title")).forEach((block) => {
          const label = element("label", "p2md-review-caption-block");
          const checkbox = element("input");
          checkbox.type = "checkbox";
          checkbox.value = block.id;
          checkbox.checked = selectedCaptionIds.has(block.id);
          const copy = element("span");
          const figure = block.formalFigureKey ? `${block.formalFigureKey} · ` : "";
          copy.textContent = `${figure}${(block.text ?? "").replace(/\s+/g, " ").slice(0, 220)}`;
          const position = element("small");
          position.textContent = `${readerText(this.locale, "textBlockLabel", { order: block.pageOrder + 1 })} · ${(block.bbox.x * 100).toFixed(0)}%, ${(block.bbox.y * 100).toFixed(0)}%`;
          label.append(checkbox, copy, position);
          captionChoices.appendChild(label);
        });
        const submit = button(readerText(this.locale, "submitCorrectCaptionLink"), "p2md-review-button p2md-review-primary");
        submit.addEventListener("click", (event) => {
          const sourceId = sourceChoices.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value ?? "";
          const captionIds = [...captionChoices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((input) => input.value);
          void this.storeVisualReviewDecision(review, {
            candidate_id: candidate.id,
            verdict: "reject",
            correction: { kind: "cross_page_caption", visual_block_id: sourceId, caption_block_ids: captionIds }
          }, event.currentTarget as HTMLElement);
        });
        details.append(summary, help, sourceHeading, sourceChoices, captionHeading, captionChoices, submit);
        card.appendChild(details);
      }
      section.appendChild(card);
    });
    return section;
  }

  private openDiagnostics(): void {
    if (!this.loaded) return;
    const status = statusCopy(this.loaded.state, this.locale);
    const content = element("div", "p2md-local-dialog-content p2md-diagnostics");
    const heading = element("h2");
    heading.textContent = readerText(this.locale, "readerDiagnostics");
    const summary = element("div", "p2md-diagnostic-summary");
    const label = element("strong");
    label.textContent = status.label;
    const version = element("span");
    version.textContent = this.loaded.contractVersion ?? readerText(this.locale, "noReaderContract");
    summary.append(label, version);
    const list = element("ul");
    const diagnostics = this.loaded.diagnostics.length
      ? this.loaded.diagnostics
      : [{ level: "info" as const, code: "valid", message: readerText(this.locale, "noContractProblems") }];
    diagnostics.forEach((diagnostic) => {
      const item = element("li");
      item.dataset.level = diagnostic.level;
      item.textContent = diagnostic.message;
      list.appendChild(item);
    });
    content.append(heading, summary, list);
    if (this.loaded.visualReview) content.appendChild(this.createVisualReviewSection(this.loaded.visualReview));
    this.openDialog(content, readerText(this.locale, "closeDiagnostics"));
  }

  private openLightbox(figure: FigurePresentation): void {
    if (!figure.available) return;
    const content = element("div", "p2md-local-dialog-content p2md-lightbox");
    const heading = element("h2");
    heading.textContent = figure.label;
    const image = element("img");
    image.src = figure.imageSrc;
    image.alt = figure.label;
    content.append(heading, image);
    if (figure.captionElement) {
      content.appendChild(figure.captionElement.cloneNode(true));
    } else if (figure.captionText) {
      const caption = element("p", "p2md-figure-caption");
      caption.textContent = figure.captionText;
      content.appendChild(caption);
    }
    this.openDialog(content, readerText(this.locale, "closeNamed", { name: figure.label }), true);
  }

  private openDialog(content: HTMLElement, closeLabel: string, lightbox = false): void {
    const dialog = element("dialog", `p2md-local-dialog${lightbox ? " p2md-local-lightbox-dialog" : ""}`);
    const closeButton = element("button", "p2md-local-dialog-close");
    closeButton.type = "button";
    closeButton.ariaLabel = closeLabel;
    setReaderIcon(closeButton, "close");
    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(closeButton, content);
    document.body.appendChild(dialog);
    dialog.showModal();
    closeButton.focus();
  }
}

export function mountReaderWorkspace(root: HTMLElement, options: ReaderWorkspaceOptions): ReaderWorkspace {
  return new ReaderWorkspace(root, options);
}
