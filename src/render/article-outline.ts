import { readerText, type ReaderLocale } from "../ui/locale";
import { setReaderIcon } from "./icons";
import { scrollReaderTarget } from "../sync/scroll-controller";
import type { ReaderArticleAnchor } from "../sync/reader-view-state";

const OUTLINE_COLLAPSED_STORAGE_KEY = "paper2md-reader:outline-collapsed";
const RUNNING_HEADER_LABELS = new Set(["article"]);
const REPORTING_FORM_BRANDS = new Set(["natureportfolio", "nature portfolio"]);
const REPORTING_FORM_ROOT_LABELS = new Set(["reporting summary"]);

export interface ArticleOutlineEntry {
  element: HTMLElement;
  label: string;
  level: number;
  targetId: string;
}

export interface ArticleOutlineTarget {
  id: string;
  label: string;
  level: number;
  active: boolean;
}

export interface ArticleOutlineOptions {
  onNavigate?: () => void;
}

function normalizedHeadingText(heading: HTMLElement): string {
  return (heading.textContent ?? "").replace(/\s+/g, " ").trim();
}

function normalizedHeadingKey(heading: HTMLElement): string {
  return normalizedHeadingText(heading).toLocaleLowerCase();
}

function reportingFormStartsAt(headings: HTMLElement[], index: number): boolean {
  if (headings[index].tagName !== "H1" || !REPORTING_FORM_BRANDS.has(normalizedHeadingKey(headings[index]))) return false;
  const nextHeading = headings[index + 1];
  return Boolean(
    nextHeading
    && nextHeading.tagName === "H2"
    && REPORTING_FORM_ROOT_LABELS.has(normalizedHeadingKey(nextHeading))
  );
}

/** Build display-only navigation targets without changing the source Markdown. */
export function collectArticleOutlineEntries(article: HTMLElement): ArticleOutlineEntry[] {
  const headings = [...article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
  const labelCounts = new Map<string, number>();
  headings.forEach((heading) => {
    const key = normalizedHeadingKey(heading);
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    delete heading.dataset.p2mdOutlineExcluded;
    delete heading.dataset.p2mdOutlineTarget;
  });
  const entries: ArticleOutlineEntry[] = [];
  let insideReportingForm = false;
  headings.forEach((heading, index) => {
    const label = normalizedHeadingText(heading);
    if (!label) return;
    const level = Number.parseInt(heading.tagName.slice(1), 10);
    if (reportingFormStartsAt(headings, index)) {
      insideReportingForm = true;
      heading.dataset.p2mdOutlineExcluded = "reporting-form";
      return;
    }
    if (insideReportingForm) {
      if (level === 1 && !REPORTING_FORM_BRANDS.has(normalizedHeadingKey(heading))) {
        insideReportingForm = false;
      } else {
        heading.dataset.p2mdOutlineExcluded = "reporting-form";
        return;
      }
    }
    const key = normalizedHeadingKey(heading);
    if (RUNNING_HEADER_LABELS.has(key) && (labelCounts.get(key) ?? 0) > 1) {
      heading.dataset.p2mdOutlineExcluded = "running-header";
      return;
    }
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
        scrollReaderTarget(this.scrollContainer, entry.element, { behavior: "smooth", block: "start" });
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

  captureReadingAnchor(): ReaderArticleAnchor | undefined {
    if (!this.entries.length) return undefined;
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const inset = Math.min(120, Math.max(0, scrollRect.height * 0.2));
    const probe = this.scrollContainer.scrollTop + inset;
    const tops = this.entries.map((entry) => (
      this.scrollContainer.scrollTop + entry.element.getBoundingClientRect().top - scrollRect.top
    ));
    let index = 0;
    for (let candidate = 0; candidate < tops.length; candidate += 1) {
      if (tops[candidate] > probe) break;
      index = candidate;
    }
    const start = tops[index];
    const end = index + 1 < tops.length ? tops[index + 1] : this.scrollContainer.scrollHeight;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
    const entry = this.entries[index];
    return {
      targetId: entry.targetId,
      label: entry.label,
      level: entry.level,
      sectionProgress: Math.max(0, Math.min(1, (probe - start) / (end - start)))
    };
  }

  restoreReadingAnchor(anchor: ReaderArticleAnchor | undefined): boolean {
    const matchingEntries = anchor
      ? this.entries.filter((candidate) => (
        candidate.targetId === anchor.targetId
        && candidate.label === anchor.label
        && candidate.level === anchor.level
      ))
      : [];
    const entry = matchingEntries.length === 1 ? matchingEntries[0] : undefined;
    if (
      !entry
      || !anchor
      || !Number.isFinite(anchor.sectionProgress)
      || anchor.sectionProgress < 0
      || anchor.sectionProgress > 1
    ) {
      this.scrollContainer.scrollTop = 0;
      return false;
    }
    const index = this.entries.indexOf(entry);
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const inset = Math.min(120, Math.max(0, scrollRect.height * 0.2));
    const start = this.scrollContainer.scrollTop + entry.element.getBoundingClientRect().top - scrollRect.top;
    const next = this.entries[index + 1];
    const end = next
      ? this.scrollContainer.scrollTop + next.element.getBoundingClientRect().top - scrollRect.top
      : this.scrollContainer.scrollHeight;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      this.scrollContainer.scrollTop = 0;
      return false;
    }
    const maximum = Math.max(0, this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight);
    const desired = start + (end - start) * anchor.sectionProgress - inset;
    const target = Math.max(0, Math.min(maximum, desired));
    this.scrollContainer.scrollTop = target;
    if (Math.abs(this.scrollContainer.scrollTop - target) > 1) {
      this.scrollContainer.scrollTop = 0;
      return false;
    }
    return true;
  }

  listTargets(): ArticleOutlineTarget[] {
    return this.entries.map((entry) => ({
      id: entry.targetId,
      label: entry.label,
      level: entry.level,
      active: entry.element === this.active
    }));
  }

  navigateTo(targetId: string): ArticleOutlineTarget | undefined {
    const entry = this.entries.find((candidate) => candidate.targetId === targetId);
    if (!entry) return undefined;
    this.options.onNavigate?.();
    this.setActive(entry.element);
    scrollReaderTarget(this.scrollContainer, entry.element, { behavior: "smooth", block: "start" });
    return { id: entry.targetId, label: entry.label, level: entry.level, active: true };
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
