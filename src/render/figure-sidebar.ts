import { setReaderIcon } from "./icons";
import { FigureFollowState } from "../sync/figure-follow-state";
import { readerText, ReaderLocale } from "../ui/locale";

export interface FigurePresentation {
  id: string;
  label: string;
  kind: string;
  imageSrc: string;
  captionElement?: HTMLElement;
  captionText?: string;
  pageIndex?: number;
  captionPageIndex?: number;
  captionStatus?: "complete" | "partial";
  slotElement?: HTMLElement;
  available: boolean;
}

export interface FigureSidebarOptions {
  onOpenImage: (figure: FigurePresentation) => void;
  onSelectionChange?: (figure: FigurePresentation, followingReading: boolean) => void;
  onStateChange?: () => void;
  locale?: ReaderLocale;
}

export interface FigureSidebarState {
  selectedVisualId: string;
  following: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class FigureSidebar {
  private figures: FigurePresentation[] = [];
  private readonly followState = new FigureFollowState();
  private readonly body: HTMLElement;
  private readonly followInput: HTMLInputElement;
  private readonly locale: ReaderLocale;

  constructor(private readonly container: HTMLElement, private readonly options: FigureSidebarOptions) {
    this.locale = options.locale ?? "en";
    this.container.classList.add("p2md-figures");
    const header = element("header", "p2md-figures-header");
    const heading = element("h2");
    heading.textContent = readerText(this.locale, "visuals");
    const followControl = element("label", "p2md-follow-control");
    followControl.title = readerText(this.locale, "followReadingHelp");
    this.followInput = element("input");
    this.followInput.type = "checkbox";
    this.followInput.checked = true;
    this.followInput.setAttribute("role", "switch");
    const track = element("span", "p2md-follow-track");
    track.setAttribute("aria-hidden", "true");
    const label = element("span", "p2md-follow-label");
    label.textContent = readerText(this.locale, "followReading");
    followControl.append(this.followInput, track, label);
    this.followInput.addEventListener("change", () => {
      if (this.followState.setFollowing(this.followInput.checked)) {
        this.render();
        this.options.onStateChange?.();
      }
    });
    header.appendChild(heading);
    header.appendChild(followControl);
    this.body = element("div", "p2md-figures-body");
    this.container.replaceChildren(header, this.body);
  }

  setFigures(figures: FigurePresentation[]): void {
    this.figures = figures;
    this.followState.setFigures(figures.map((figure) => figure.id));
    this.followInput.disabled = figures.length === 0;
    this.render();
  }

  select(id: string, notify = false): void {
    const figure = this.figures.find((item) => item.id === id);
    const changed = notify && figure?.slotElement
      ? this.followState.selectForNavigation(id)
      : this.followState.select(id);
    if (!changed) return;
    this.render();
    if (notify) {
      if (figure) this.options.onSelectionChange?.(figure, this.followState.isFollowing);
    }
  }

  navigateTo(id: string): boolean {
    const figure = this.figures.find((item) => item.id === id);
    if (!figure) return false;
    const changed = figure.slotElement
      ? this.followState.selectForNavigation(id)
      : this.followState.select(id);
    if (changed) this.render();
    this.options.onSelectionChange?.(figure, this.followState.isFollowing);
    return true;
  }

  trackReadingTarget(id: string): void {
    if (this.followState.trackReadingTarget(id)) this.render();
  }

  activateReadingFollowing(): void {
    if (this.followState.cancelPendingNavigation()) this.render();
  }

  setFollowing(value: boolean): FigureSidebarState {
    if (this.followState.setFollowing(value)) {
      this.followInput.checked = this.followState.isFollowing;
      this.render();
      this.options.onStateChange?.();
    }
    return this.getState();
  }

  getState(): FigureSidebarState {
    return { selectedVisualId: this.followState.selected ?? "", following: this.followState.isFollowing };
  }

  restoreState(state: FigureSidebarState): void {
    this.followState.setFollowing(state.following);
    if (state.selectedVisualId) this.followState.select(state.selectedVisualId);
    this.followInput.checked = this.followState.isFollowing;
    this.render();
  }

  private render(): void {
    this.body.replaceChildren();
    if (!this.figures.length) {
      const empty = element("div", "p2md-figures-empty");
      const heading = element("strong");
      heading.textContent = readerText(this.locale, "noVisuals");
      const copy = element("span");
      copy.textContent = readerText(this.locale, "noVisualsCopy");
      empty.append(heading, copy);
      this.body.appendChild(empty);
      return;
    }

    const selected = this.figures.find((figure) => figure.id === this.followState.selected) ?? this.figures[0];
    const stage = element("section", "p2md-figure-stage");
    const stageHeader = element("div", "p2md-figure-stage-header");
    const title = element("h3");
    title.textContent = selected.label;
    const count = element("span");
    const page = selected.pageIndex === undefined
      ? ""
      : selected.captionPageIndex !== undefined && selected.captionPageIndex !== selected.pageIndex
        ? ` · ${readerText(this.locale, "visualCaptionPages", {
          visualPage: selected.pageIndex + 1,
          captionPage: selected.captionPageIndex + 1
        })}`
        : ` · ${readerText(this.locale, "pageNumber", { page: selected.pageIndex + 1 })}`;
    count.textContent = `${this.figures.indexOf(selected) + 1} / ${this.figures.length}${page}`;
    stageHeader.append(title, count);

    const imageButton = element("button", "p2md-figure-image-button");
    imageButton.type = "button";
    imageButton.ariaLabel = readerText(this.locale, "openNamed", { name: selected.label });
    imageButton.disabled = !selected.available;
    if (selected.available) {
      const image = element("img");
      image.src = selected.imageSrc;
      image.alt = selected.label;
      image.loading = "lazy";
      imageButton.appendChild(image);
      imageButton.addEventListener("click", () => this.options.onOpenImage(selected));
    } else {
      const missing = element("div", "p2md-missing-image");
      missing.textContent = readerText(this.locale, "imageUnavailable");
      imageButton.appendChild(missing);
    }

    const caption = element("div", "p2md-figure-caption");
    if (selected.captionElement) {
      const clone = selected.captionElement.cloneNode(true) as HTMLElement;
      clone.removeAttribute("id");
      clone.classList.remove("p2md-inline-caption");
      delete clone.dataset.p2mdAssetId;
      caption.appendChild(clone);
    } else if (selected.captionText) {
      caption.textContent = selected.captionText;
    } else {
      caption.textContent = selected.label;
    }
    if (selected.captionStatus === "partial") {
      const note = element("p", "p2md-figure-caption-note");
      note.textContent = readerText(this.locale, "partialCaptionNotice");
      caption.appendChild(note);
    }

    const actions = element("div", "p2md-figure-actions");
    const openButton = element("button", "p2md-action-button");
    openButton.type = "button";
    openButton.disabled = !selected.available;
    setReaderIcon(openButton, "expand");
    const openLabel = element("span");
    openLabel.textContent = readerText(this.locale, "openImage");
    openButton.appendChild(openLabel);
    openButton.addEventListener("click", () => this.options.onOpenImage(selected));
    actions.appendChild(openButton);

    if (selected.slotElement) {
      const backButton = element("button", "p2md-action-button");
      backButton.type = "button";
      setReaderIcon(backButton, "arrow-up-to-line");
      const backLabel = element("span");
      backLabel.textContent = readerText(this.locale, "backToPosition");
      backButton.appendChild(backLabel);
      backButton.addEventListener("click", () => selected.slotElement?.scrollIntoView({ behavior: "smooth", block: "center" }));
      actions.appendChild(backButton);
    }

    stage.append(stageHeader, imageButton, caption, actions);

    const rail = element("nav", "p2md-thumbnail-rail");
    rail.ariaLabel = readerText(this.locale, "paperVisualAssets");
    for (const figure of this.figures) {
      const button = element("button", "p2md-thumbnail");
      button.type = "button";
      button.dataset.selected = String(figure.id === selected.id);
      button.dataset.readingTarget = String(figure.id === this.followState.readingTarget);
      button.ariaPressed = String(figure.id === selected.id);
      if (figure.id === this.followState.readingTarget) button.setAttribute("aria-current", "location");
      button.ariaLabel = readerText(this.locale, "showNamed", { name: figure.label });
      if (figure.available) {
        const image = element("img");
        image.src = figure.imageSrc;
        image.alt = "";
        image.loading = "lazy";
        button.appendChild(image);
      }
      const label = element("span");
      label.textContent = figure.label;
      button.appendChild(label);
      button.addEventListener("click", () => {
        if (figure.slotElement) this.followState.selectForNavigation(figure.id);
        else this.followState.select(figure.id);
        this.render();
        this.options.onSelectionChange?.(figure, this.followState.isFollowing);
        this.options.onStateChange?.();
      });
      rail.appendChild(button);
    }

    this.body.append(stage, rail);
  }
}
