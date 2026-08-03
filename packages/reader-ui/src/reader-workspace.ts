import { ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import { assetDisplayLabel, LoadedPaperPackage } from "../../../src/model/reader-contract";
import { PackageLoader } from "../../../src/model/package-loader";
import { PackageLimitError } from "../../../src/model/package-limits";
import { bindContractAssets } from "../../../src/render/contract-renderer";
import type { RenderedArticle } from "../../../src/render/contract-renderer";
import { FigurePresentation, FigureSidebar } from "../../../src/render/figure-sidebar";
import { setReaderIcon } from "../../../src/render/icons";
import { renderLocalArticle } from "../../../src/render/local-article-renderer";
import { UnsafeMarkdownResourceError } from "../../../src/render/markdown-resource-policy";
import { ScrollController } from "../../../src/sync/scroll-controller";
import {
  getReaderLocale,
  readerText,
  ReaderLocale,
  setReaderLocale,
  subscribeReaderLocale
} from "../../../src/ui/locale";
import { statusCopy } from "../../../src/ui/status-copy";
import type { ReaderPackagePicker } from "../../reader-core/src/index";

export interface ReaderWorkspaceOptions {
  picker: ReaderPackagePicker;
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
  private figureSidebar!: FigureSidebar;
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
    this.scrollController.disconnect();
    this.fileSystem?.dispose();
    this.options.picker.dispose?.();
    this.stopLocaleSubscription();
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
    this.locale = locale;
    this.scrollController.disconnect();
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
    this.scrollController.disconnect();
    this.fileSystem?.dispose();
    this.fileSystem = fileSystem;
    this.fileLabel.textContent = fileSystem.rootLabel;
    this.reloadButton.disabled = false;
    await this.loadPackage();
  }

  private renderShell(): void {
    this.root.className = "p2md-reader-view p2md-local-reader-view";
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

    const workspace = element("div", "p2md-reader-workspace");
    this.articleScroll = element("main", "p2md-article-scroll");
    this.articleContent = element("article", "p2md-article markdown-rendered");
    this.articleScroll.appendChild(this.articleContent);
    const figureHost = element("aside", "p2md-figures-host");
    workspace.append(this.articleScroll, figureHost);
    reader.append(toolbar, workspace);
    this.root.replaceChildren(reader);

    this.figureSidebar = new FigureSidebar(figureHost, {
      locale: this.locale,
      onOpenImage: (figure) => this.openLightbox(figure),
      onSelectionChange: (figure, followingReading) => {
        if (followingReading) figure.slotElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
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

  private async loadPackage(): Promise<void> {
    if (!this.fileSystem) return;
    this.scrollController.disconnect();
    this.articleContent.setAttribute("aria-busy", "true");
    this.statusButton.disabled = true;
    this.statusLabel.textContent = readerText(this.locale, "loading");
    this.root.dataset.state = "loading";
    try {
      if (!await this.fileSystem.exists("article.md")) {
        this.loaded = undefined;
        this.renderFailure(readerText(this.locale, "missingArticle"));
        return;
      }
      const loaded = await new PackageLoader(this.fileSystem).load("article.md");
      this.loaded = loaded;
      this.updateStatus(loaded);
      const contractUsable = loaded.state === "valid" || loaded.state === "edited-with-anchors" || loaded.state === "recoverable";
      this.root.classList.toggle("p2md-contract-mode", contractUsable);
      const rendered = await renderLocalArticle(loaded.articleText, this.articleContent, this.fileSystem, contractUsable);
      if (contractUsable) bindContractAssets(rendered, loaded.assets);
      this.figureSidebar.setFigures(await this.createFigurePresentations(loaded, rendered, contractUsable));
      this.connectScrollSync(loaded, rendered, contractUsable);
      this.root.dataset.state = contractUsable ? "ready" : "degraded";
      this.articleScroll.scrollTop = 0;
    } catch (error) {
      console.error("Paper2MD Reader failed to load", error);
      this.loaded = undefined;
      const message = error instanceof PackageLimitError || error instanceof UnsafeMarkdownResourceError
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
          imageSrc = await this.fileSystem.resolveAssetUrl(asset.path);
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
        slotElement: slotId ? rendered.slotElements.get(slotId) : undefined,
        available: asset.exists && Boolean(imageSrc)
      };
    }));
  }

  private connectScrollSync(loaded: LoadedPaperPackage, rendered: RenderedArticle, contractUsable: boolean): void {
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
  }

  private updateStatus(loaded: LoadedPaperPackage): void {
    const status = statusCopy(loaded.state, this.locale);
    this.statusLabel.textContent = status.label;
    this.statusButton.dataset.tone = status.tone;
    this.statusButton.disabled = false;
    this.statusButton.title = loaded.diagnostics[0]?.message ?? status.label;
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
    const note = element("small");
    note.textContent = this.localizedCopy("emptyNote", "contractValidatedNote");
    empty.append(title, copy, openButton, note);
    this.articleContent.appendChild(empty);
    this.figureSidebar.setFigures([]);
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
    this.statusLabel.textContent = readerText(this.locale, "loadFailed");
    this.statusButton.dataset.tone = "error";
    this.statusButton.disabled = true;
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
    if (figure.captionElement) content.appendChild(figure.captionElement.cloneNode(true));
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
