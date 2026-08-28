export class ScrollController {
  private observer?: IntersectionObserver;
  private pageRoot?: HTMLElement;
  private pageListener?: () => void;
  private pageFrame = 0;

  connect(root: HTMLElement, slots: Map<string, HTMLElement>, slotToAsset: Map<string, string>, onActiveAsset: (assetId: string) => void): void {
    this.disconnectVisuals();
    if (!slots.size) return;

    this.observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      const slotId = (visible[0]?.target as HTMLElement | undefined)?.dataset.p2mdSlotId;
      const assetId = slotId ? slotToAsset.get(slotId) : undefined;
      if (assetId) onActiveAsset(assetId);
    }, {
      root,
      rootMargin: "-18% 0px -45% 0px",
      threshold: 0
    });

    slots.forEach((slot) => this.observer?.observe(slot));
  }

  connectPages(root: HTMLElement, blocks: HTMLElement[], onActivePage: (pageNumber: number) => void): void {
    this.disconnectPages();
    if (!blocks.length) return;
    this.pageRoot = root;
    const update = () => {
      this.pageFrame = 0;
      const rect = root.getBoundingClientRect();
      onActivePage(readerPageAtViewportTop(blocks.map((block) => {
        const blockRect = block.getBoundingClientRect();
        return {
          pageNumber: Number(block.dataset.p2mdPageOwner || 1),
          top: blockRect.top,
          bottom: blockRect.bottom
        };
      }), rect.top + 1, rect.bottom, 1));
    };
    const schedule = () => {
      if (this.pageFrame) return;
      this.pageFrame = requestAnimationFrame(update);
    };
    this.pageListener = schedule;
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
  }

  disconnect(): void {
    this.disconnectVisuals();
    this.disconnectPages();
  }

  private disconnectVisuals(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private disconnectPages(): void {
    if (this.pageRoot && this.pageListener) this.pageRoot.removeEventListener("scroll", this.pageListener);
    if (this.pageListener) window.removeEventListener("resize", this.pageListener);
    if (this.pageFrame) cancelAnimationFrame(this.pageFrame);
    this.pageRoot = undefined;
    this.pageListener = undefined;
    this.pageFrame = 0;
  }
}

export type ReaderScrollBlock = "start" | "center";

export function readerScrollTopForTarget(input: {
  currentScrollTop: number;
  containerTop: number;
  containerHeight: number;
  targetTop: number;
  targetHeight: number;
  maximumScrollTop: number;
  block: ReaderScrollBlock;
}): number {
  const alignment = input.block === "center"
    ? input.targetTop + input.targetHeight / 2 - (input.containerTop + input.containerHeight / 2)
    : input.targetTop - input.containerTop;
  return Math.max(0, Math.min(input.maximumScrollTop, input.currentScrollTop + alignment));
}

/** Scroll only the article viewport; never let scrollIntoView move the desktop shell. */
export function scrollReaderTarget(
  container: HTMLElement,
  target: HTMLElement,
  options: { behavior?: ScrollBehavior; block?: ReaderScrollBlock } = {}
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  container.scrollTo({
    top: readerScrollTopForTarget({
      currentScrollTop: container.scrollTop,
      containerTop: containerRect.top,
      containerHeight: containerRect.height,
      targetTop: targetRect.top,
      targetHeight: targetRect.height,
      maximumScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      block: options.block ?? "start"
    }),
    behavior: options.behavior ?? "smooth"
  });
}

export interface ReaderViewportBlock {
  pageNumber: number;
  top: number;
  bottom: number;
}

export function readerPageAtViewportTop(
  blocks: readonly ReaderViewportBlock[],
  viewportTop: number,
  viewportBottom: number,
  fallbackPage = 1
): number {
  const top = Number.isFinite(viewportTop) ? viewportTop : 0;
  const bottom = Number.isFinite(viewportBottom) ? Math.max(top, viewportBottom) : Number.POSITIVE_INFINITY;
  const visible = blocks.filter((block) => (
    Number.isFinite(block.pageNumber)
    && block.pageNumber > 0
    && Number.isFinite(block.top)
    && Number.isFinite(block.bottom)
    && block.bottom > top + 0.5
    && block.top < bottom - 0.5
  )).sort((left, right) => {
    const leftTop = Math.max(top, left.top);
    const rightTop = Math.max(top, right.top);
    return leftTop - rightTop || left.top - right.top || left.bottom - right.bottom;
  });
  return Math.max(1, Math.floor(visible[0]?.pageNumber || fallbackPage));
}
