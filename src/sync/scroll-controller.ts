export class ScrollController {
  private observer?: IntersectionObserver;

  connect(root: HTMLElement, slots: Map<string, HTMLElement>, slotToAsset: Map<string, string>, onActiveAsset: (assetId: string) => void): void {
    this.disconnect();
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

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
