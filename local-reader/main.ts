import "../styles.css";
import "./local-reader.css";
import { BrowserDirectoryReaderFileSystem } from "../src/filesystem/browser-directory-reader-file-system";
import { ReaderFileSystem } from "../src/filesystem/reader-file-system";
import { assetDisplayLabel, LoadedPaperPackage } from "../src/model/reader-contract";
import { PackageLoader } from "../src/model/package-loader";
import { bindContractAssets, RenderedArticle } from "../src/render/contract-renderer";
import { FigurePresentation, FigureSidebar } from "../src/render/figure-sidebar";
import { setReaderIcon } from "../src/render/icons";
import { renderLocalArticle } from "../src/render/local-article-renderer";
import { ScrollController } from "../src/sync/scroll-controller";
import { STATUS_COPY } from "../src/ui/status-copy";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

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

class LocalReaderApp {
  private fileSystem?: ReaderFileSystem;
  private loaded?: LoadedPaperPackage;
  private articleScroll!: HTMLElement;
  private articleContent!: HTMLElement;
  private fileLabel!: HTMLElement;
  private statusButton!: HTMLButtonElement;
  private statusLabel!: HTMLElement;
  private reloadButton!: HTMLButtonElement;
  private figureSidebar!: FigureSidebar;
  private folderInput!: HTMLInputElement;
  private readonly scrollController = new ScrollController();

  private readonly handleBeforeUnload = () => this.fileSystem?.dispose();

  constructor(private readonly root: HTMLElement) {
    this.renderShell();
    this.renderWelcome();
    window.addEventListener("beforeunload", this.handleBeforeUnload);
  }

  destroy(): void {
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    this.scrollController.disconnect();
    this.fileSystem?.dispose();
    this.root.replaceChildren();
  }

  private renderShell(): void {
    this.root.className = "p2md-reader-view p2md-local-reader-view";
    const reader = element("div", "p2md-reader");
    const toolbar = element("header", "p2md-toolbar");

    const leading = element("div", "p2md-toolbar-group");
    const title = element("strong", "p2md-view-title");
    title.textContent = "Paper2MD Local Reader";
    const chooseButton = button("Open folder", "p2md-local-folder-button", "folder");
    chooseButton.addEventListener("click", () => void this.chooseDirectory());
    leading.append(title, chooseButton);

    this.fileLabel = element("div", "p2md-file-label");
    this.fileLabel.textContent = "No folder selected";

    const trailing = element("div", "p2md-toolbar-group p2md-toolbar-trailing");
    this.statusButton = element("button", "p2md-contract-status");
    this.statusButton.type = "button";
    this.statusButton.disabled = true;
    this.statusLabel = element("span");
    this.statusLabel.textContent = "No package";
    this.statusButton.appendChild(this.statusLabel);
    this.statusButton.addEventListener("click", () => this.openDiagnostics());
    this.reloadButton = element("button", "p2md-icon-button");
    this.reloadButton.type = "button";
    this.reloadButton.ariaLabel = "Reload package";
    this.reloadButton.disabled = true;
    setReaderIcon(this.reloadButton, "refresh");
    this.reloadButton.addEventListener("click", () => void this.loadPackage());
    trailing.append(this.statusButton, this.reloadButton);

    toolbar.append(leading, this.fileLabel, trailing);

    const workspace = element("div", "p2md-reader-workspace");
    this.articleScroll = element("main", "p2md-article-scroll");
    this.articleContent = element("article", "p2md-article markdown-rendered");
    this.articleScroll.appendChild(this.articleContent);
    const figureHost = element("aside", "p2md-figures-host");
    workspace.append(this.articleScroll, figureHost);

    this.folderInput = element("input", "p2md-local-folder-input");
    this.folderInput.type = "file";
    this.folderInput.multiple = true;
    this.folderInput.setAttribute("webkitdirectory", "");
    this.folderInput.addEventListener("change", () => {
      if (this.folderInput.files?.length) {
        void this.attachFileSystem(BrowserDirectoryReaderFileSystem.fromFileList(this.folderInput.files));
      }
      this.folderInput.value = "";
    });

    reader.append(toolbar, workspace, this.folderInput);
    this.root.replaceChildren(reader);

    this.figureSidebar = new FigureSidebar(figureHost, {
      onOpenImage: (figure) => this.openLightbox(figure),
      onSelectionChange: (figure, followingReading) => {
        if (followingReading) figure.slotElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  private async chooseDirectory(): Promise<void> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    const forceInputFallback = new URLSearchParams(window.location.search).has("folder-input");
    if (!picker || forceInputFallback) {
      this.folderInput.click();
      return;
    }

    try {
      const handle = await picker.call(window, { mode: "read" });
      await this.attachFileSystem(BrowserDirectoryReaderFileSystem.fromDirectoryHandle(handle));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Could not open local directory", error);
      this.renderFailure("The selected folder could not be opened.");
    }
  }

  private async attachFileSystem(fileSystem: ReaderFileSystem): Promise<void> {
    this.scrollController.disconnect();
    this.fileSystem?.dispose();
    this.fileSystem = fileSystem;
    this.fileLabel.textContent = fileSystem.rootLabel;
    this.reloadButton.disabled = false;
    await this.loadPackage();
  }

  private async loadPackage(): Promise<void> {
    if (!this.fileSystem) return;
    this.scrollController.disconnect();
    this.articleContent.setAttribute("aria-busy", "true");
    this.statusButton.disabled = true;
    this.statusLabel.textContent = "Loading…";
    this.root.dataset.state = "loading";

    try {
      if (!await this.fileSystem.exists("article.md")) {
        this.loaded = undefined;
        this.renderFailure("This folder does not contain article.md.");
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
      console.error("Paper2MD Local Reader failed to load", error);
      this.loaded = undefined;
      this.renderFailure("The paper package could not be loaded. Check the folder and retry.");
    } finally {
      this.articleContent.removeAttribute("aria-busy");
    }
  }

  private async createFigurePresentations(
    loaded: LoadedPaperPackage,
    rendered: RenderedArticle,
    contractUsable: boolean
  ): Promise<FigurePresentation[]> {
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
    this.scrollController.connect(this.articleScroll, rendered.slotElements, slotToAsset, (assetId) => this.figureSidebar.trackReadingTarget(assetId));
  }

  private updateStatus(loaded: LoadedPaperPackage): void {
    const status = STATUS_COPY[loaded.state];
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
    title.textContent = "Read a Paper2MD package locally";
    const copy = element("p");
    copy.textContent = "Choose a folder containing article.md and _paper2md/reader.json. Files stay on this device.";
    const openButton = button("Open paper folder", "p2md-local-primary-button", "folder");
    openButton.addEventListener("click", () => void this.chooseDirectory());
    const note = element("small");
    note.textContent = "Read-only · no upload · Chrome or Edge recommended";
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
    title.textContent = "Unable to open package";
    const copy = element("p");
    copy.textContent = message;
    const chooseButton = button("Choose another folder", "p2md-local-primary-button", "folder");
    chooseButton.addEventListener("click", () => void this.chooseDirectory());
    empty.append(title, copy, chooseButton);
    this.articleContent.appendChild(empty);
    this.figureSidebar.setFigures([]);
    this.statusLabel.textContent = "Load failed";
    this.statusButton.dataset.tone = "error";
    this.statusButton.disabled = true;
  }

  private openDiagnostics(): void {
    if (!this.loaded) return;
    const status = STATUS_COPY[this.loaded.state];
    const content = element("div", "p2md-local-dialog-content p2md-diagnostics");
    const heading = element("h2");
    heading.textContent = "Reader diagnostics";
    const summary = element("div", "p2md-diagnostic-summary");
    const label = element("strong");
    label.textContent = status.label;
    const version = element("span");
    version.textContent = this.loaded.contractVersion ?? "No reader contract";
    summary.append(label, version);
    const list = element("ul");
    const diagnostics = this.loaded.diagnostics.length
      ? this.loaded.diagnostics
      : [{ level: "info" as const, code: "valid", message: "No contract problems detected." }];
    diagnostics.forEach((diagnostic) => {
      const item = element("li");
      item.dataset.level = diagnostic.level;
      item.textContent = diagnostic.message;
      list.appendChild(item);
    });
    content.append(heading, summary, list);
    this.openDialog(content, "Close diagnostics");
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
    this.openDialog(content, `Close ${figure.label}`, true);
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

export function mountLocalReader(root: HTMLElement): () => void {
  const app = new LocalReaderApp(root);
  return () => app.destroy();
}
