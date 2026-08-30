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
  previewMinerUVisualReviewDecision,
  type MinerUReviewVerdict,
  type MinerUVisualReview,
  type MinerUVisualReviewDecision,
  type MinerUVisualReviewSidecar,
  visualReviewSidecarByteLength
} from "../../../src/model/mineru-visual-review";
import { bindContractAssets } from "../../../src/render/contract-renderer";
import type { RenderedArticle } from "../../../src/render/contract-renderer";
import { ArticleOutline } from "../../../src/render/article-outline";
import { FigurePresentation, FigureSidebar, FigureSidebarOptions, FigureSidebarState } from "../../../src/render/figure-sidebar";
import type { PdfReferenceRuntime } from "../../../src/render/pdf-reference-pane";
import { ReferenceSidebar } from "../../../src/render/reference-sidebar";
import { materializeReaderPageOwnership } from "../../../src/render/page-ownership";
import { setReaderIcon } from "../../../src/render/icons";
import { renderLocalArticle } from "../../../src/render/local-article-renderer";
import { UnsafeMarkdownResourceError } from "../../../src/render/markdown-resource-policy";
import { appendSafeCaptionMarkup } from "../../../src/render/caption-markup";
import { ScrollController, scrollReaderTarget } from "../../../src/sync/scroll-controller";
import {
  DEFAULT_READER_VIEW_STATE,
  parseReaderViewState,
  READER_VIEW_STATE_VERSION,
  type ReaderArticleAnchor,
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
import type {
  ReaderPackagePicker,
  ReaderPdfDocumentSelection,
  ReaderProcessingProgress
} from "../../reader-core/src/index";
import type {
  ReaderAgentController,
  ReaderAgentPage,
  ReaderAgentState,
  ReaderFollowTarget,
  ReaderHeadingSummary,
  ReaderVisualRepairCandidateSummary,
  ReaderVisualSummary
} from "./reader-agent-controller";
import type { ReferenceMode } from "../../../src/render/reference-sidebar";

export interface ReaderPaperStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ReaderCapabilityProfile = "strict-readonly" | "legacy-v0.1.3";
export type ReaderVisualReviewMode = "disabled" | "read-only" | "legacy-editable";

export interface ReaderVisualReviewSource {
  read(candidatePackageSha256: string): Promise<unknown | undefined>;
}

export interface ReaderVisualReviewSink {
  write(candidatePackageSha256: string, sidecar: MinerUVisualReviewSidecar): Promise<void>;
}

export interface ReaderWorkspaceOptions {
  picker: ReaderPackagePicker;
  /**
   * Select the Reader product boundary. Strict read-only mode consumes raw or
   * verified package content without applying legacy runtime projections,
   * external review decisions, or PDF text recovery. The legacy profile is the
   * compatibility default for desktop v0.1.3 and existing Local Reader hosts.
   */
  capabilityProfile?: ReaderCapabilityProfile;
  /**
   * Allow the legacy Reader to repair displayed text from a bundled PDF at
   * runtime. This legacy override is always ignored by strict-readonly.
   */
  allowRuntimeTextRecovery?: boolean;
  /**
   * Control whether verified legacy visual-review evidence is hidden, shown
   * without mutation controls, or editable through the v0.1.3 compatibility UI.
   * Strict read-only always resolves this to disabled.
   */
  visualReviewMode?: ReaderVisualReviewMode;
  /** Host-owned storage for paper-derived view state and browser visual-review sidecars. */
  paperStateStorage?: ReaderPaperStateStorage;
  /** Host source for an existing, package-hash-bound legacy visual-review sidecar. */
  visualReviewSource?: ReaderVisualReviewSource;
  /** Host sink used only by the legacy editable compatibility UI. */
  visualReviewSink?: ReaderVisualReviewSink;
  /** @deprecated Use visualReviewSource and visualReviewSink for explicit capabilities. */
  visualReviewStore?: {
    read(candidatePackageSha256: string): Promise<unknown | undefined>;
    write?(candidatePackageSha256: string, sidecar: MinerUVisualReviewSidecar): Promise<void>;
  };
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

interface ReaderFigureController {
  setFigures(figures: FigurePresentation[]): void;
  trackReadingTarget(id: string): void;
  activateReadingFollowing(): void;
  navigateTo(id: string): boolean;
  setFollowing(value: boolean): unknown;
  getState(): FigureSidebarState | ReturnType<ReferenceSidebar["getState"]>;
}

const MAX_AGENT_LABEL_CHARS = 500;
const MAX_AGENT_CAPTION_CHARS = 2_000;
const MAX_AGENT_PAGE_SIZE = 200;
const MAX_AGENT_REPAIR_BLOCKS = 128;

function boundedAgentText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function agentPage<T>(items: T[], start = 0, limit = 100): ReaderAgentPage<T> {
  const safeStart = Number.isSafeInteger(start) && start >= 0 ? start : 0;
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MAX_AGENT_PAGE_SIZE, limit)) : 100;
  const pageItems = items.slice(safeStart, safeStart + safeLimit);
  const nextStart = safeStart + pageItems.length < items.length ? safeStart + pageItems.length : undefined;
  return { items: pageItems, total: items.length, start: safeStart, nextStart };
}

export class ReaderWorkspace implements ReaderAgentController {
  private fileSystem?: ReaderFileSystem;
  private contentFileSystem?: ReaderFileSystem;
  private loaded?: LoadedPaperPackage;
  private pdfDocumentSession?: Pick<ReaderPdfDocumentSelection, "pdfPath" | "label">;
  private articleScroll!: HTMLElement;
  private articleContent!: HTMLElement;
  private articleOutline?: ArticleOutline;
  private fileLabel!: HTMLElement;
  private statusButton!: HTMLButtonElement;
  private statusLabel!: HTMLElement;
  private reloadButton!: HTMLButtonElement;
  private figureSidebar!: ReaderFigureController;
  private referenceSidebar?: ReferenceSidebar;
  private figures: FigurePresentation[] = [];
  private workspaceElement!: HTMLElement;
  private splitRatio = DEFAULT_READER_VIEW_STATE.splitRatio;
  private stateKey?: string;
  private stateSaveTimer = 0;
  private articleLayoutGeneration = 0;
  private cancelArticleAnchorRevalidation?: () => void;
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

  private isStrictReadOnly(): boolean {
    return this.options.capabilityProfile === "strict-readonly";
  }

  private allowsRuntimeTextRecovery(): boolean {
    return !this.isStrictReadOnly() && this.options.allowRuntimeTextRecovery !== false;
  }

  private effectiveVisualReviewMode(): ReaderVisualReviewMode {
    if (this.isStrictReadOnly()) return "disabled";
    return this.options.visualReviewMode ?? "legacy-editable";
  }

  private visualReviewSource(): ReaderVisualReviewSource | undefined {
    return this.options.visualReviewSource ?? this.options.visualReviewStore;
  }

  private visualReviewSink(): ReaderVisualReviewSink | undefined {
    if (this.options.visualReviewSink) return this.options.visualReviewSink;
    const store = this.options.visualReviewStore;
    return store?.write ? {
      write: (candidatePackageSha256, sidecar) => store.write!(candidatePackageSha256, sidecar)
    } : undefined;
  }

  destroy(): void {
    this.invalidateArticleLayout();
    this.saveViewState();
    if (this.stateSaveTimer) window.clearTimeout(this.stateSaveTimer);
    this.scrollController.disconnect();
    this.articleOutline?.destroy();
    this.referenceSidebar?.destroy();
    this.options.visualResolver?.dispose();
    this.disposeContentFileSystem();
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
      this.fileLabel.textContent = this.pdfDocumentSession?.label ?? this.fileSystem.rootLabel;
      this.reloadButton.disabled = false;
      if (this.pdfDocumentSession) void this.loadPdfDocumentSession();
      else void this.loadPackage();
    } else {
      this.renderWelcome();
    }
  }

  async attachFileSystem(fileSystem: ReaderFileSystem): Promise<void> {
    this.saveViewState();
    this.scrollController.disconnect();
    this.options.visualResolver?.dispose();
    this.disposeContentFileSystem();
    this.fileSystem?.dispose();
    this.fileSystem = fileSystem;
    this.pdfDocumentSession = undefined;
    this.root.classList.remove("p2md-pdf-document-mode");
    this.fileLabel.textContent = fileSystem.rootLabel;
    this.reloadButton.disabled = false;
    await this.loadPackage();
  }

  async attachPdfDocument(selection: ReaderPdfDocumentSelection): Promise<void> {
    if (!this.options.pdfRuntime || !this.referenceSidebar) {
      selection.fileSystem.dispose();
      throw new Error(readerText(this.locale, "selectedPdfDocumentOpenFailed"));
    }
    this.saveViewState();
    this.scrollController.disconnect();
    this.options.visualResolver?.dispose();
    this.disposeContentFileSystem();
    this.fileSystem?.dispose();
    this.fileSystem = selection.fileSystem;
    this.pdfDocumentSession = { pdfPath: selection.pdfPath, label: selection.label };
    this.loaded = undefined;
    this.stateKey = undefined;
    this.fileLabel.textContent = selection.label;
    this.reloadButton.disabled = false;
    await this.loadPdfDocumentSession();
  }

  async refreshPackage(): Promise<void> {
    if (this.pdfDocumentSession) await this.loadPdfDocumentSession();
    else await this.loadPackage();
  }

  getReaderState(): ReaderAgentState {
    const lifecycle = (["idle", "loading", "ready", "degraded", "error"] as const).includes(
      this.root.dataset.state as ReaderAgentState["lifecycle"]
    ) ? this.root.dataset.state as ReaderAgentState["lifecycle"] : "idle";
    const reference = this.readerReferenceState();
    const headings = this.articleOutline?.listTargets() ?? [];
    return {
      lifecycle,
      package: this.loaded ? {
        label: boundedAgentText(this.fileSystem?.rootLabel, MAX_AGENT_LABEL_CHARS) ?? "",
        articleSha256: this.loaded.articleHash,
        sourceFormat: this.loaded.sourceFormat,
        packageState: this.loaded.state,
        packageIntegrity: this.loaded.packageIntegrity,
        contractVersion: this.loaded.contractVersion
      } : undefined,
      headingCount: headings.length,
      activeHeadingId: headings.find((heading) => heading.active)?.id,
      visualCount: this.figures.length,
      repairCandidateCount: this.effectiveVisualReviewMode() === "disabled"
        ? 0
        : this.loaded?.visualReview?.candidates.length ?? 0,
      reference
    };
  }

  listHeadings(start = 0, limit = 100): ReaderAgentPage<ReaderHeadingSummary> {
    const headings = (this.articleOutline?.listTargets() ?? []).map((heading) => ({
      ...heading,
      label: boundedAgentText(heading.label, MAX_AGENT_LABEL_CHARS) ?? ""
    }));
    return agentPage(headings, start, limit);
  }

  listVisuals(start = 0, limit = 100): ReaderAgentPage<ReaderVisualSummary> {
    const selected = this.readerReferenceState().selectedVisualId;
    const visuals = this.figures.map((figure) => ({
      id: figure.id,
      label: boundedAgentText(figure.label, MAX_AGENT_LABEL_CHARS) ?? figure.id,
      kind: figure.kind,
      available: figure.available,
      selected: figure.id === selected,
      hasArticleAnchor: Boolean(figure.slotElement),
      page: figure.pageIndex === undefined ? undefined : figure.pageIndex + 1,
      captionPage: figure.captionPageIndex === undefined ? undefined : figure.captionPageIndex + 1,
      captionStatus: figure.captionStatus,
      captionText: boundedAgentText(figure.captionText, MAX_AGENT_CAPTION_CHARS)
    }));
    return agentPage(visuals, start, limit);
  }

  navigateToHeading(id: string): ReaderHeadingSummary {
    const heading = this.articleOutline?.navigateTo(id);
    if (!heading) throw new Error("Reader heading ID was not found in the current article");
    this.scheduleViewStateSave();
    return { ...heading, label: boundedAgentText(heading.label, MAX_AGENT_LABEL_CHARS) ?? "" };
  }

  navigateToVisual(id: string): ReaderVisualSummary {
    const visual = this.figures.find((item) => item.id === id);
    if (!visual || !this.figureSidebar.navigateTo(id)) {
      throw new Error("Reader visual ID was not found in the current package");
    }
    this.referenceSidebar?.setMode("visuals");
    this.scheduleViewStateSave();
    return this.listVisuals(0, MAX_AGENT_PAGE_SIZE).items.find((item) => item.id === id)!;
  }

  setReferenceMode(mode: ReferenceMode): ReaderAgentState["reference"] {
    if (!this.referenceSidebar) throw new Error("Reference modes are unavailable in this Reader host");
    const selected = this.referenceSidebar.setMode(mode);
    if (selected !== mode) throw new Error("The requested reference mode is unavailable for the current package");
    this.scheduleViewStateSave();
    return this.readerReferenceState();
  }

  setFollowMode(target: ReaderFollowTarget, enabled: boolean): ReaderAgentState["reference"] {
    if (target === "pdf") {
      if (!this.referenceSidebar || (!this.loaded?.sourcePdf && !this.pdfDocumentSession)) {
        throw new Error("PDF following is unavailable for the current document");
      }
      this.referenceSidebar.setPdfFollowing(enabled);
    } else if (this.referenceSidebar) {
      this.referenceSidebar.setVisualFollowing(enabled);
    } else {
      this.figureSidebar.setFollowing(enabled);
    }
    this.scheduleViewStateSave();
    return this.readerReferenceState();
  }

  getVisualRepairCandidates(start = 0, limit = 100): ReaderAgentPage<ReaderVisualRepairCandidateSummary> {
    if (this.effectiveVisualReviewMode() === "disabled") return agentPage([], start, limit);
    const review = this.loaded?.visualReview;
    if (!review) return agentPage([], start, limit);
    const decisions = new Map(review.decisions.map((decision) => [decision.candidate_id, decision]));
    const candidates = review.candidates.map((candidate) => {
      const relevantPages = new Set([candidate.pageIndex, candidate.targetPageIndex].filter((value): value is number => value !== undefined));
      const relevantBlocks = review.blocks.filter((block) => relevantPages.has(block.pageIndex));
      return {
        id: candidate.id,
        kind: candidate.kind,
        page: candidate.pageIndex + 1,
        targetPage: candidate.targetPageIndex === undefined ? undefined : candidate.targetPageIndex + 1,
        memberBlockIds: [...candidate.memberBlockIds],
        replacementMode: candidate.replacementMode,
        figureKey: candidate.figureKey,
        visualBlockId: candidate.visualBlockId,
        captionBlockIds: candidate.captionBlockIds ? [...candidate.captionBlockIds] : undefined,
        decision: decisions.get(candidate.id) ? structuredClone(decisions.get(candidate.id)!) : undefined,
        blockCount: relevantBlocks.length,
        blocksTruncated: relevantBlocks.length > MAX_AGENT_REPAIR_BLOCKS,
        blocks: relevantBlocks.slice(0, MAX_AGENT_REPAIR_BLOCKS).map((block) => ({
          id: block.id,
          page: block.pageIndex + 1,
          order: block.pageOrder + 1,
          role: block.role,
          bbox: { ...block.bbox },
          text: boundedAgentText(block.text, MAX_AGENT_LABEL_CHARS),
          formalFigureKey: boundedAgentText(block.formalFigureKey, MAX_AGENT_LABEL_CHARS)
        }))
      };
    });
    return agentPage(candidates, start, limit);
  }

  async previewVisualCorrection(decision: MinerUVisualReviewDecision) {
    if (this.effectiveVisualReviewMode() === "disabled") {
      throw new Error("Visual repair preview is disabled in strict read-only Reader mode");
    }
    const review = this.loaded?.visualReview;
    if (!review) throw new Error("Visual repair candidates are unavailable for the current package");
    return previewMinerUVisualReviewDecision(review, decision);
  }

  private readerReferenceState(): ReaderAgentState["reference"] {
    const reference = this.referenceSidebar?.getState();
    const visual = reference ?? this.figureSidebar?.getState();
    return {
      available: Boolean(this.referenceSidebar),
      mode: reference?.mode ?? "visuals",
      pdfAvailable: Boolean(this.referenceSidebar && (this.loaded?.sourcePdf || this.pdfDocumentSession)),
      selectedVisualId: visual?.selectedVisualId ?? "",
      visualFollowing: "visualFollowing" in (visual ?? {})
        ? Boolean((visual as ReturnType<ReferenceSidebar["getState"]>).visualFollowing)
        : Boolean((visual as FigureSidebarState | undefined)?.following ?? true),
      pdfFollowing: reference?.pdf.following ?? false,
      pdfPage: reference?.pdf.page ?? 1
    };
  }

  private renderShell(): void {
    this.articleOutline?.destroy();
    this.articleOutline = undefined;
    this.root.classList.remove("p2md-external-figures", "p2md-contract-mode");
    this.root.classList.add("p2md-reader-view", "p2md-local-reader-view");
    this.root.classList.toggle("p2md-external-figures", Boolean(this.options.figureHost));
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
    this.reloadButton.addEventListener("click", () => void this.reloadCurrent());
    trailing.append(languageSelect, this.statusButton, this.reloadButton);
    toolbar.append(leading, this.fileLabel, trailing);

    const workspace = element(
      "div",
      `p2md-reader-workspace${this.options.figureHost ? " p2md-reader-workspace-external-figures" : ""}`
    );
    this.workspaceElement = workspace;
    this.applySplitRatio(this.splitRatio);
    const readingPane = element("div", "p2md-reading-pane");
    const outlineHost = element("aside", "p2md-outline");
    this.articleScroll = element("main", "p2md-article-scroll");
    this.articleContent = element("article", "p2md-article markdown-rendered");
    this.articleScroll.appendChild(this.articleContent);
    readingPane.append(outlineHost, this.articleScroll);
    const activateMarkdownFollowing = () => this.referenceSidebar?.activateMarkdownFollowing();
    const resumeReadingAuthority = () => {
      this.cancelPendingArticleAnchorRevalidation();
      activateMarkdownFollowing();
      this.figureSidebar.activateReadingFollowing();
    };
    this.articleScroll.addEventListener("pointerenter", activateMarkdownFollowing);
    this.articleScroll.addEventListener("pointerdown", resumeReadingAuthority);
    this.articleScroll.addEventListener("wheel", resumeReadingAuthority, { passive: true });
    this.articleScroll.addEventListener("focusin", resumeReadingAuthority);
    this.articleScroll.addEventListener("scroll", () => this.scheduleViewStateSave(), { passive: true });
    const figureHost = this.options.figureHost ?? element("aside", "p2md-figures-host");
    workspace.appendChild(readingPane);
    if (!this.options.figureHost) {
      workspace.append(this.createSplitter(), figureHost);
    }
    reader.append(toolbar, workspace);
    this.root.replaceChildren(reader);

    const figureOptions: FigureSidebarOptions = {
      locale: this.locale,
      onOpenImage: (figure) => this.openLightbox(figure),
      onSelectionChange: (figure, followingReading) => {
        if (followingReading && figure.slotElement) {
          scrollReaderTarget(this.articleScroll, figure.slotElement, { behavior: "smooth", block: "center" });
        }
      }
    };
    if (this.options.figureHost && !this.options.pdfRuntime) {
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
    this.articleOutline = new ArticleOutline(outlineHost, this.articleScroll, this.locale, {
      onNavigate: resumeReadingAuthority
    });
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

  private async reloadCurrent(): Promise<void> {
    if (this.pdfDocumentSession) await this.loadPdfDocumentSession();
    else await this.loadPackage();
  }

  private async loadPackage(): Promise<void> {
    if (!this.fileSystem) return;
    if (this.pdfDocumentSession) {
      await this.loadPdfDocumentSession();
      return;
    }
    const sourceFileSystem = this.fileSystem;
    const articleLayoutGeneration = this.invalidateArticleLayout();
    const isCurrentLoad = () => (
      articleLayoutGeneration === this.articleLayoutGeneration
      && sourceFileSystem === this.fileSystem
      && !this.pdfDocumentSession
    );
    const disposeLoadedContent = (loaded: LoadedPaperPackage | undefined) => {
      if (loaded?.contentFileSystem && loaded.contentFileSystem !== sourceFileSystem) {
        loaded.contentFileSystem.dispose();
      }
    };
    if (this.loaded) this.saveViewState();
    this.disposeContentFileSystem();
    this.loaded = undefined;
    this.stateKey = undefined;
    this.scrollController.disconnect();
    this.articleOutline?.clear();
    this.articleContent.setAttribute("aria-busy", "true");
    this.statusButton.disabled = true;
    this.statusLabel.textContent = readerText(this.locale, "loading");
    this.root.dataset.state = "loading";
    let loaded: LoadedPaperPackage | undefined;
    try {
      const loader = new PackageLoader(sourceFileSystem, {
        allowRuntimeTextRecovery: this.allowsRuntimeTextRecovery(),
        legacyMinerUProjectionMode: this.isStrictReadOnly() ? "source-only" : "compatible"
      });
      loaded = await loader.loadDetected();
      if (!isCurrentLoad()) {
        disposeLoadedContent(loaded);
        return;
      }
      let storedSidecar: unknown | undefined;
      const visualReviewMode = this.effectiveVisualReviewMode();
      const visualReviewSource = this.visualReviewSource();
      if (visualReviewMode !== "disabled" && loaded.visualReview && visualReviewSource) {
        try {
          storedSidecar = await visualReviewSource.read(loaded.visualReview.packageHash);
          if (!isCurrentLoad()) {
            disposeLoadedContent(loaded);
            return;
          }
        } catch {
          loaded.diagnostics.push({
            level: "warning",
            code: "mineru-visual-review-file-store-unavailable",
            message: "本地视觉修复 sidecar 无法安全读取，已忽略用户决定；正文和已验证视觉投影仍可继续加载。"
          });
        }
      } else if (visualReviewMode !== "disabled") {
        storedSidecar = this.readVisualReviewSidecar(loaded);
      }
      if (storedSidecar !== undefined) {
        disposeLoadedContent(loaded);
        loaded = undefined;
        loaded = await loader.loadDetected(storedSidecar);
        if (!isCurrentLoad()) {
          disposeLoadedContent(loaded);
          return;
        }
      }
      const contentFileSystem = loaded.contentFileSystem ?? sourceFileSystem;
      const nextStateKey = loaded.articleHash ? readerViewStateKey(loaded.articleHash) : undefined;
      const restoredState = this.loadViewState(nextStateKey);
      const contractUsable = loaded.state === "valid" || loaded.state === "edited-with-anchors" || loaded.state === "recoverable" || loaded.state === "mineru" || loaded.state === "markdown";
      let articleText = loaded.articleText;
      if (
        this.allowsRuntimeTextRecovery()
        && loaded.textRecovery
        && (
          loaded.textRecovery.candidates.length
          || loaded.textRecovery.captionContinuations?.length
          || loaded.textRecovery.paragraphRecoveries?.length
        )
        && this.options.visualResolver?.recoverText
      ) {
        const recovered = await this.options.visualResolver.recoverText(articleText, loaded.textRecovery, contentFileSystem);
        if (!isCurrentLoad()) {
          disposeLoadedContent(loaded);
          return;
        }
        articleText = recovered.articleText;
        loaded.diagnostics.push(...recovered.diagnostics);
        const resolvedCaptionBlocks = new Set<string>();
        recovered.captionUpdates?.forEach((update) => {
          const asset = loaded!.assets.find((candidate) => candidate.id === update.visualId);
          if (!asset) return;
          asset.captionText = update.captionText;
          asset.captionStatus = update.captionStatus;
          if (update.captionStatus === "complete") asset.memberBlockIds?.forEach((id) => resolvedCaptionBlocks.add(id));
        });
        if (resolvedCaptionBlocks.size && loaded.visualReview) {
          const unresolved = loaded.visualReview.candidates.filter((candidate) => !(
            candidate.kind === "cross_page_caption"
            && candidate.visualBlockId
            && resolvedCaptionBlocks.has(candidate.visualBlockId)
          ));
          if (unresolved.length !== loaded.visualReview.candidates.length) {
            const resolvedCount = loaded.visualReview.candidates.length - unresolved.length;
            loaded.visualReview = { ...loaded.visualReview, candidates: unresolved };
            loaded.diagnostics.push({
              level: "info",
              code: "mineru-visual-review-runtime-resolved",
              message: `已由原 PDF 文本层确定性解决 ${resolvedCount} 个跨页图注候选。`
            });
          }
        }
      }
      articleText = injectMinerUPageAnchors(articleText, loaded.pageMap);
      const stagedArticle = document.createElement("article");
      stagedArticle.className = this.articleContent.className;
      const rendered = await renderLocalArticle(articleText, stagedArticle, contentFileSystem, contractUsable);
      if (!isCurrentLoad()) {
        disposeLoadedContent(loaded);
        return;
      }
      const pageBlocks = loaded.pageMap ? materializeReaderPageOwnership(stagedArticle) : [];
      if (contractUsable) bindContractAssets(rendered, loaded.assets);
      const figures = await this.createFigurePresentations(loaded, rendered, contractUsable, contentFileSystem);
      if (!isCurrentLoad()) {
        disposeLoadedContent(loaded);
        return;
      }
      const referenceSidebar = this.referenceSidebar;
      if (referenceSidebar) await referenceSidebar.setPdfSource(loaded.sourcePdf, contentFileSystem, loaded.pdfLayout);
      if (!isCurrentLoad() || referenceSidebar !== this.referenceSidebar) {
        disposeLoadedContent(loaded);
        return;
      }

      this.loaded = loaded;
      this.contentFileSystem = loaded.contentFileSystem;
      this.stateKey = nextStateKey;
      this.splitRatio = restoredState.splitRatio;
      this.applySplitRatio(this.splitRatio);
      this.root.classList.toggle("p2md-contract-mode", contractUsable);
      this.updateStatus(loaded);
      this.articleContent.replaceChildren(...stagedArticle.childNodes);
      this.articleOutline?.setArticle(this.articleContent);
      this.figures = figures;
      this.figureSidebar.setFigures(figures);
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
      const articlePositionRestored = this.articleOutline?.restoreReadingAnchor(restoredState.articleAnchor) ?? false;
      if (!articlePositionRestored) this.articleScroll.scrollTop = 0;
      else this.scheduleArticleAnchorRevalidation(restoredState.articleAnchor, articleLayoutGeneration);
      this.articleOutline?.refreshActive();
    } catch (error) {
      if (!isCurrentLoad()) {
        disposeLoadedContent(loaded);
        return;
      }
      this.cancelPendingArticleAnchorRevalidation();
      console.error("Paper2MD Reader failed to load", error);
      if (this.loaded === loaded) this.contentFileSystem = undefined;
      this.loaded = undefined;
      disposeLoadedContent(loaded);
      const message = error instanceof PackageSourceNotFoundError
        ? readerText(this.locale, "noReadablePackage")
        : error instanceof PackageLimitError || error instanceof MinerUPackageIntegrityError || error instanceof UnsafeMarkdownResourceError
        ? error.message
        : readerText(this.locale, "packageLoadFailed");
      this.renderFailure(message);
    } finally {
      if (isCurrentLoad()) this.articleContent.removeAttribute("aria-busy");
    }
  }

  private async loadPdfDocumentSession(): Promise<void> {
    const fileSystem = this.fileSystem;
    const session = this.pdfDocumentSession;
    if (!fileSystem || !session) return;
    if (!this.referenceSidebar || !this.options.pdfRuntime) {
      this.renderFailure(readerText(this.locale, "selectedPdfDocumentOpenFailed"));
      return;
    }
    const articleLayoutGeneration = this.invalidateArticleLayout();
    this.scrollController.disconnect();
    this.loaded = undefined;
    this.stateKey = undefined;
    this.articleOutline?.clear();
    this.figures = [];
    this.figureSidebar.setFigures([]);
    this.root.classList.remove("p2md-contract-mode");
    this.root.classList.add("p2md-pdf-document-mode");
    this.root.dataset.state = "loading";
    this.statusButton.disabled = true;
    this.statusButton.dataset.tone = "pdf";
    this.statusLabel.textContent = readerText(this.locale, "loadingPdf");
    this.articleContent.setAttribute("aria-busy", "true");
    this.articleContent.replaceChildren();
    const placeholder = element("div", "p2md-reader-empty p2md-pdf-document-placeholder");
    const title = element("h2");
    title.textContent = readerText(this.locale, "pdfOnlyTitle");
    const copy = element("p");
    copy.textContent = readerText(this.locale, "pdfOnlyCopy");
    placeholder.append(title, copy);
    this.articleContent.appendChild(placeholder);
    this.articleScroll.scrollTop = 0;
    try {
      await this.referenceSidebar.setPdfOnlySource({ path: session.pdfPath }, fileSystem);
      if (
        articleLayoutGeneration !== this.articleLayoutGeneration
        || fileSystem !== this.fileSystem
        || session !== this.pdfDocumentSession
      ) return;
      this.statusLabel.textContent = readerText(this.locale, "pdfOnlyReady");
      this.root.dataset.state = "ready";
    } catch (error) {
      if (fileSystem !== this.fileSystem || session !== this.pdfDocumentSession) return;
      console.error("Paper2MD Reader failed to open PDF", error);
      this.renderFailure(error instanceof Error && error.message
        ? error.message
        : readerText(this.locale, "selectedPdfDocumentOpenFailed"));
    } finally {
      if (fileSystem === this.fileSystem && session === this.pdfDocumentSession) {
        this.articleContent.removeAttribute("aria-busy");
      }
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
      let imageSrc = "";
      if (asset.exists) {
        try {
          imageSrc = this.options.visualResolver
            ? await this.options.visualResolver.resolve(asset, contentFileSystem)
            : await contentFileSystem.resolveAssetUrl(asset.path);
        } catch (error) {
          console.error(`Could not reconstruct visual ${asset.id}; the incomplete source fragment will remain hidden`, error);
          imageSrc = "";
        }
      }
      const slotElement = slotId ? rendered.slotElements.get(slotId) : undefined;
      if (slotElement && imageSrc) this.materializeDerivedInlineVisual(slotElement, asset, imageSrc);
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
        slotElement,
        available: asset.exists && Boolean(imageSrc)
      };
    }));
  }

  private disposeContentFileSystem(): void {
    if (this.contentFileSystem && this.contentFileSystem !== this.fileSystem) {
      this.contentFileSystem.dispose();
    }
    this.contentFileSystem = undefined;
  }

  private activeContentFileSystem(): ReaderFileSystem | undefined {
    return this.contentFileSystem ?? this.fileSystem;
  }

  private materializeDerivedInlineVisual(slot: HTMLElement, asset: LoadedAsset, imageSrc: string): void {
    const articleRoot = slot.closest<HTMLElement>(".p2md-article") ?? this.articleContent;
    const alreadyBound = [...articleRoot.querySelectorAll<HTMLElement>(".p2md-inline-asset")]
      .some((element) => element.dataset.p2mdAssetId === asset.id);
    if (alreadyBound) return;
    const figure = element("figure", "p2md-inline-asset p2md-derived-inline-asset");
    figure.dataset.p2mdAssetId = asset.id;
    const image = document.createElement("img");
    image.src = imageSrc;
    image.alt = assetDisplayLabel(asset);
    image.decoding = "async";
    image.loading = "lazy";
    figure.appendChild(image);
    if (asset.captionText?.trim()) {
      const caption = element("figcaption", "p2md-derived-inline-caption");
      appendSafeCaptionMarkup(caption, asset.captionText.trim());
      figure.appendChild(caption);
    }
    slot.insertAdjacentElement("afterend", figure);
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
    const hasPartialCaptions = loaded.assets.some((asset) => asset.captionStatus === "partial");
    const status = loaded.state === "mineru" && loaded.packageIntegrity
      ? {
        label: readerText(this.locale, loaded.packageIntegrity === "verified"
          ? hasPartialCaptions ? "statusMineruVerifiedPartial" : "statusMineruVerified"
          : "statusMineruUnverified"),
        tone: loaded.packageIntegrity === "verified" && !hasPartialCaptions ? "ok" : "warning"
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

  private invalidateArticleLayout(): number {
    this.articleLayoutGeneration += 1;
    this.cancelPendingArticleAnchorRevalidation();
    return this.articleLayoutGeneration;
  }

  private cancelPendingArticleAnchorRevalidation(): void {
    this.cancelArticleAnchorRevalidation?.();
    this.cancelArticleAnchorRevalidation = undefined;
  }

  /**
   * Images and web fonts can change heading geometry after the first paint. Reapply
   * the same verified semantic anchor once after that initial layout settles (or a
   * bounded timeout), never a raw pixel position. A generation change invalidates
   * all callbacks from a destroyed Reader or an older package load.
   */
  private scheduleArticleAnchorRevalidation(
    anchor: ReaderArticleAnchor | undefined,
    generation: number
  ): void {
    const outline = this.articleOutline;
    const article = this.articleContent;
    const scroll = this.articleScroll;
    if (!anchor || !outline || generation !== this.articleLayoutGeneration) return;

    this.cancelPendingArticleAnchorRevalidation();
    const pendingImages = [...article.querySelectorAll<HTMLImageElement>("img")].filter((image) => !image.complete);
    const imageListeners = new Map<HTMLImageElement, () => void>();
    let active = true;
    let completed = false;
    let imagesSettled = pendingImages.length === 0;
    let fontsSettled = typeof document.fonts === "undefined";
    let timeoutId = 0;
    let firstFrame = 0;
    let secondFrame = 0;

    const requestFrame = (callback: FrameRequestCallback): number => (
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(() => callback(Date.now()), 0)
    );
    const cancelFrame = (id: number): void => {
      if (!id) return;
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(id);
      else window.clearTimeout(id);
    };
    const clearWaiters = (): void => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = 0;
      imageListeners.forEach((listener, image) => {
        image.removeEventListener("load", listener);
        image.removeEventListener("error", listener);
      });
      imageListeners.clear();
    };
    const isCurrent = (): boolean => (
      active
      && generation === this.articleLayoutGeneration
      && outline === this.articleOutline
      && article === this.articleContent
      && scroll === this.articleScroll
    );
    const cancel = (): void => {
      active = false;
      clearWaiters();
      cancelFrame(firstFrame);
      cancelFrame(secondFrame);
      firstFrame = 0;
      secondFrame = 0;
    };
    const revalidate = (): void => {
      if (completed || !isCurrent()) return;
      completed = true;
      clearWaiters();
      firstFrame = requestFrame(() => {
        firstFrame = 0;
        if (!isCurrent()) return;
        secondFrame = requestFrame(() => {
          secondFrame = 0;
          if (!isCurrent()) return;
          active = false;
          if (this.cancelArticleAnchorRevalidation === cancel) {
            this.cancelArticleAnchorRevalidation = undefined;
          }
          if (!outline.restoreReadingAnchor(anchor)) scroll.scrollTop = 0;
          outline.refreshActive();
        });
      });
    };
    const revalidateWhenSettled = (): void => {
      if (imagesSettled && fontsSettled) revalidate();
    };

    pendingImages.forEach((image) => {
      const listener = () => {
        if (!active || !imageListeners.has(image)) return;
        image.removeEventListener("load", listener);
        image.removeEventListener("error", listener);
        imageListeners.delete(image);
        imagesSettled = imageListeners.size === 0;
        revalidateWhenSettled();
      };
      imageListeners.set(image, listener);
      image.addEventListener("load", listener, { once: true });
      image.addEventListener("error", listener, { once: true });
    });

    this.cancelArticleAnchorRevalidation = cancel;
    timeoutId = window.setTimeout(() => {
      imagesSettled = true;
      fontsSettled = true;
      revalidate();
    }, 1_000);
    if (typeof document.fonts !== "undefined") {
      void document.fonts.ready.then(() => {
        if (!active) return;
        fontsSettled = true;
        revalidateWhenSettled();
      }).catch(() => {
        if (!active) return;
        fontsSettled = true;
        revalidateWhenSettled();
      });
    }
    revalidateWhenSettled();
  }

  private loadViewState(stateKey = this.stateKey): ReaderPersistedViewState {
    if (!stateKey) return { ...DEFAULT_READER_VIEW_STATE };
    try {
      return parseReaderViewState(this.paperStateStorage().getItem(stateKey));
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
      version: READER_VIEW_STATE_VERSION,
      splitRatio: this.splitRatio,
      articleScrollTop: this.articleScroll.scrollTop,
      articleAnchor: this.articleOutline?.captureReadingAnchor(),
      referenceMode: reference?.mode ?? "visuals",
      pdfPage: reference?.pdf.page ?? 1,
      pdfZoom: reference?.pdf.zoom ?? 1,
      pdfFollowing: reference?.pdf.following ?? true,
      showLayoutBoxes: reference?.pdf.showLayoutBoxes ?? true,
      selectedVisualId: reference?.selectedVisualId ?? "",
      visualFollowing: reference?.visualFollowing ?? true
    };
    try {
      this.paperStateStorage().setItem(this.stateKey, JSON.stringify(state));
    } catch {
      // Storage can be unavailable in hardened or private browser contexts.
    }
  }

  private renderWelcome(): void {
    this.root.dataset.state = "idle";
    this.articleOutline?.clear();
    this.figures = [];
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
    if (this.options.picker.choosePdfDocument) {
      const directPdfButton = button(readerText(this.locale, "openPdfFile"), "p2md-local-secondary-button", "document");
      directPdfButton.addEventListener("click", () => void this.choosePdfDocument());
      actions.appendChild(directPdfButton);
    }
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

  private async choosePdfDocument(): Promise<void> {
    try {
      const selection = await this.options.picker.choosePdfDocument?.();
      if (selection) await this.attachPdfDocument(selection);
    } catch (error) {
      console.error("Could not open PDF document", error);
      this.renderFailure(error instanceof Error && error.message
        ? error.message
        : readerText(this.locale, "selectedPdfDocumentOpenFailed"));
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
    this.root.classList.remove("p2md-contract-mode", "p2md-pdf-document-mode");
    this.articleOutline?.clear();
    this.figures = [];
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
    if (this.effectiveVisualReviewMode() === "disabled") return undefined;
    const review = loaded.visualReview;
    if (!review) return undefined;
    try {
      const raw = this.paperStateStorage().getItem(review.storageKey);
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
    if (this.effectiveVisualReviewMode() !== "legacy-editable") return;
    const decisions = new Map(review.decisions.map((item) => [item.candidate_id, item]));
    decisions.set(decision.candidate_id, decision);
    const sidecar = createVisualReviewSidecar(review.packageHash, [...decisions.values()]);
    try {
      if (visualReviewSidecarByteLength(sidecar) > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
        throw new Error("Visual review sidecar exceeds 64 KiB");
      }
      const sink = this.visualReviewSink();
      if (sink) {
        await sink.write(review.packageHash, sidecar);
      } else if (this.options.visualReviewSource || this.options.visualReviewStore) {
        throw new Error("Visual review store is read-only");
      } else {
        this.paperStateStorage().setItem(review.storageKey, JSON.stringify(sidecar));
      }
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

  private paperStateStorage(): ReaderPaperStateStorage {
    return this.options.paperStateStorage ?? window.localStorage;
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
      if (this.effectiveVisualReviewMode() !== "legacy-editable") {
        card.appendChild(cardHeader);
        section.appendChild(card);
        return;
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
          const contentFileSystem = this.activeContentFileSystem();
          if (block.assetPath && contentFileSystem) {
            const image = element("img");
            image.alt = "";
            void contentFileSystem.resolveAssetUrl(block.assetPath).then((url) => { image.src = url; }).catch(() => undefined);
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
          const contentFileSystem = this.activeContentFileSystem();
          if (block.assetPath && contentFileSystem) {
            const image = element("img");
            image.alt = "";
            void contentFileSystem.resolveAssetUrl(block.assetPath).then((url) => { image.src = url; }).catch(() => undefined);
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
    if (this.loaded.visualReview && this.effectiveVisualReviewMode() !== "disabled") {
      content.appendChild(this.createVisualReviewSection(this.loaded.visualReview));
    }
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
      appendSafeCaptionMarkup(caption, figure.captionText);
      content.appendChild(caption);
    }
    if (figure.captionStatus === "partial") {
      const note = element("p", "p2md-figure-caption-note");
      note.textContent = readerText(this.locale, "partialCaptionNotice");
      content.appendChild(note);
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
