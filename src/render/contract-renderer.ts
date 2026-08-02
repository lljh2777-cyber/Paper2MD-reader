import { assetDisplayLabel, LoadedAsset } from "../model/reader-contract";

export interface RenderedArticle {
  blockElements: Map<string, HTMLElement>;
  slotElements: Map<string, HTMLElement>;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

export function materializeContractAnchors(markdown: string): string {
  return markdown
    .replace(/<!--\s*p2md:block\s+id="([^"]+)"(?:\s+kind="([^"]+)")?\s*-->/g, (_all, id: string, kind?: string) =>
      `<div class="p2md-contract-anchor p2md-block-anchor" data-p2md-anchor-id="${escapeAttribute(id)}" data-p2md-kind="${escapeAttribute(kind ?? "body")}" aria-hidden="true"></div>\n`)
    .replace(/<!--\s*p2md:slot\s+id="([^"]+)"(?:\s+asset="([^"]+)")?\s*-->/g, (_all, id: string, asset?: string) =>
      `<div class="p2md-contract-anchor p2md-slot-anchor" data-p2md-slot-id="${escapeAttribute(id)}"${asset ? ` data-p2md-slot-asset="${escapeAttribute(asset)}"` : ""} aria-hidden="true"></div>\n`);
}

function nextContentElement(anchor: HTMLElement): HTMLElement | undefined {
  let element = anchor.nextElementSibling as HTMLElement | null;
  while (element?.classList.contains("p2md-contract-anchor")) {
    element = element.nextElementSibling as HTMLElement | null;
  }
  return element ?? undefined;
}

export function collectAnchors(container: HTMLElement): RenderedArticle {
  const blockElements = new Map<string, HTMLElement>();
  const slotElements = new Map<string, HTMLElement>();

  container.querySelectorAll<HTMLElement>(".p2md-block-anchor").forEach((anchor) => {
    const id = anchor.dataset.p2mdAnchorId;
    const target = nextContentElement(anchor);
    if (!id || !target) return;
    target.dataset.p2mdBlockId = id;
    target.classList.add("p2md-bound-block");
    blockElements.set(id, target);
  });

  container.querySelectorAll<HTMLElement>(".p2md-slot-anchor").forEach((slot) => {
    const id = slot.dataset.p2mdSlotId;
    if (id) slotElements.set(id, slot);
  });

  return { blockElements, slotElements };
}

function matchesAssetImage(element: HTMLElement, asset: LoadedAsset): boolean {
  const filename = asset.path.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (!filename) return false;
  return [...element.querySelectorAll<HTMLImageElement>("img")].some((image) => {
    const sourcePath = image.dataset.p2mdSourcePath?.toLowerCase();
    if (sourcePath) return sourcePath.endsWith(filename);
    const src = decodeURIComponent(image.getAttribute("src") ?? "").toLowerCase();
    return src.endsWith(filename) || src.includes(`/${filename}`);
  });
}

export function bindContractAssets(rendered: RenderedArticle, assets: LoadedAsset[]): void {
  for (const asset of assets) {
    const slotId = asset.placement_block_id;
    if (slotId) {
      const slot = rendered.slotElements.get(slotId);
      if (slot) {
        const label = assetDisplayLabel(asset);
        slot.dataset.p2mdAssetId = asset.id;
        slot.dataset.p2mdLabel = label;
        slot.classList.add("p2md-figure-slot");
        slot.textContent = label;

        let candidate = nextContentElement(slot);
        let inspected = 0;
        while (candidate && inspected < 4) {
          if (matchesAssetImage(candidate, asset)) {
            candidate.classList.add("p2md-inline-asset");
            candidate.dataset.p2mdAssetId = asset.id;
            break;
          }
          if (candidate.classList.contains("p2md-contract-anchor")) break;
          candidate = candidate.nextElementSibling as HTMLElement | null ?? undefined;
          inspected += 1;
        }
      }
    }

    if (asset.caption_block_id) {
      const caption = rendered.blockElements.get(asset.caption_block_id);
      caption?.classList.add("p2md-inline-caption");
      if (caption) caption.dataset.p2mdAssetId = asset.id;
    }
  }
}
