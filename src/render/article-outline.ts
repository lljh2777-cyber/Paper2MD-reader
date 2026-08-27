import { readerText, type ReaderLocale } from "../ui/locale";
import { setReaderIcon } from "./icons";

const OUTLINE_COLLAPSED_STORAGE_KEY = "paper2md-reader:outline-collapsed";

export interface ArticleOutlineEntry {
  element: HTMLElement;
  label: string;
  level: number;
  targetId: string;
}

export interface ArticleOutlineOptions {
  onNavigate?: () => void;
}

function normalizedHeadingText(heading: HTMLElement): string {
  return (heading.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Build display-only navigation targets without changing the source Markdown. */
export function collectArticleOutlineEntries(article: HTMLElement): ArticleOutlineEntry[] {
  const entries: ArticleOutlineEntry[] = [];
  article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((heading, index) => {
    const label = normalizedHeadingText(heading);
    if (!label) return;
    const level = Number.parseInt(heading.tagName.slice(1), 10);
    const targetId = heading.id || `p2md-outline-heading-${index + 1}`;
    if (!heading.id) heading.id = targetId;
    heading.dataset.p2mdOutlineTarget = targetId;
    entries.push({ element: heading, label, level, targetId });
  });
  return entries;
}

function storedCollapsedState(): boolean {
  try {
    return globalThis.localStorage?.getItem(OUTLINE_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function storeCollapsedState(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(OUTLINE_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Collapsing still works for this session when storage is unavailable.
  }
}

export class ArticleOutline {
  private entries: ArticleOutlineEntry[] = [];
  private buttons = new Map<HTMLElement, HTMLButtonElement>();
  private active?: HTMLElement;
  private animationFrame = 0;
  private collapsed = storedCollapsedState();
  private readonly title: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly list: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly scrollContainer: HTMLElement,
    private readonly locale: ReaderLocale,
    private readonly options: ArticleOutlineOptions = {}
  ) {
    this.host.className = "p2md-outline";
    const header = document.createElement("header");
    header.className = "p2md-outline-header";
    this.title = document.createElement("h2");
    this.title.textContent = readerText(locale, "outline");
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "p2md-outline-toggle p2md-icon-button";
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    header.append(this.title, this.toggle);
    this.list = document.createElement("nav");
    this.list.className = "p2md-outline-list";
    this.list.ariaLabel = readerText(locale, "outline");
    this.host.append(header, this.list);
    this.scrollContainer.addEventListener("scroll", this.scheduleActiveUpdate, { passive: true });
    this.setCollapsed(this.collapsed, false);
  }

  destroy(): void {
    this.scrollContainer.removeEventListener("scroll", this.scheduleActiveUpdate);
    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame);
    this.host.replaceChildren();
  }

  clear(): void {
    this.entries = [];
    this.buttons.clear();
    this.active = undefined;
    this.list.replaceChildren();
  }

  setArticle(article: HTMLElement): void {
    this.clear();
    this.entries = collectArticleOutlineEntries(article);
    if (!this.entries.length) {
      const empty = document.createElement("p");
      empty.className = "p2md-outline-empty";
      empty.textContent = readerText(this.locale, "noOutlineHeadings");
      this.list.appendChild(empty);
      return;
    }
    this.entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "p2md-outline-item";
      item.dataset.level = String(entry.level);
      item.dataset.targetId = entry.targetId;
      item.textContent = entry.label;
      item.title = entry.label;
      item.addEventListener("click", () => {
        this.options.onNavigate?.();
        this.setActive(entry.element);
        entry.element.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      this.buttons.set(entry.element, item);
      this.list.appendChild(item);
    });
    this.refreshActive();
  }

  refreshActive(): void {
    if (!this.entries.length) return;
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const activationLine = scrollRect.top + Math.min(120, scrollRect.height * 0.2);
    let current = this.entries[0]!.element;
    for (const entry of this.entries) {
      if (entry.element.getBoundingClientRect().top > activationLine) break;
      current = entry.element;
    }
    this.setActive(current);
  }

  private readonly scheduleActiveUpdate = (): void => {
    if (this.animationFrame) return;
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = 0;
      this.refreshActive();
    });
  };

  private setActive(heading: HTMLElement): void {
    if (heading === this.active) return;
    const previous = this.active ? this.buttons.get(this.active) : undefined;
    if (previous) {
      previous.dataset.active = "false";
      previous.removeAttribute("aria-current");
    }
    this.active = heading;
    const next = this.buttons.get(heading);
    if (!next) return;
    next.dataset.active = "true";
    next.setAttribute("aria-current", "location");
    const listTop = this.list.scrollTop;
    const listBottom = listTop + this.list.clientHeight;
    const itemTop = next.offsetTop;
    const itemBottom = itemTop + next.offsetHeight;
    if (itemTop < listTop) this.list.scrollTop = itemTop;
    else if (itemBottom > listBottom) this.list.scrollTop = itemBottom - this.list.clientHeight;
  }

  private setCollapsed(collapsed: boolean, persist = true): void {
    this.collapsed = collapsed;
    this.host.dataset.collapsed = String(collapsed);
    this.toggle.replaceChildren();
    setReaderIcon(this.toggle, collapsed ? "chevron-right" : "chevron-left");
    const label = readerText(this.locale, collapsed ? "showOutline" : "hideOutline");
    this.toggle.ariaLabel = label;
    this.toggle.title = label;
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    if (persist) storeCollapsedState(collapsed);
  }
}
