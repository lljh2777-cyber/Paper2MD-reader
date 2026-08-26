import { isSafeRelativePath } from "./contract-validation";
import { NormalizedBBox } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

export type MinerUPdfLayoutRole = "text" | "title" | "visual" | "table" | "equation" | "other";

export interface MinerUPdfLayoutBlock {
  id: string;
  pageIndex: number;
  role: MinerUPdfLayoutRole;
  sourceType: string;
  bbox: NormalizedBBox;
  visualId?: string;
  assetPath?: string;
}

export interface MinerUPdfLayout {
  pageCount: number;
  blocks: MinerUPdfLayoutBlock[];
}

interface VisualMembership {
  id: string;
  memberBlockIds?: string[];
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function normalizedBbox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [left, top, right, bottom] = value as number[];
  if (left < 0 || top < 0 || right <= left || bottom <= top || right > 1000 || bottom > 1000) return undefined;
  return { x: left / 1000, y: top / 1000, width: (right - left) / 1000, height: (bottom - top) / 1000 };
}

function hashMatches(viewer: UnknownRecord, articleHash: string, mineruHash: string): boolean {
  const inputs = record(viewer.inputs);
  return record(inputs?.article)?.sha256 === articleHash
    && record(inputs?.mineru_result)?.sha256 === mineruHash;
}

function role(value: unknown): MinerUPdfLayoutRole | undefined {
  return ["text", "title", "visual", "table", "equation", "other"].includes(String(value))
    ? String(value) as MinerUPdfLayoutRole
    : undefined;
}

/**
 * Exposes only hash-bound, normalized ViewerIndex geometry to the PDF UI.
 * Invalid blocks are omitted independently; stale contracts disable the layer.
 */
export function buildMinerUPdfLayout(
  viewerIndex: unknown,
  visuals: readonly VisualMembership[],
  articleHash: string,
  mineruHash: string
): MinerUPdfLayout | undefined {
  const viewer = record(viewerIndex);
  if (!viewer || !hashMatches(viewer, articleHash, mineruHash) || !Array.isArray(viewer.pages)) return undefined;
  const visualByBlock = new Map<string, string>();
  for (const visual of visuals) {
    for (const blockId of visual.memberBlockIds ?? []) {
      if (visualByBlock.has(blockId)) visualByBlock.set(blockId, "");
      else visualByBlock.set(blockId, visual.id);
    }
  }
  const blocks: MinerUPdfLayoutBlock[] = [];
  let pageCount = 0;
  for (const pageValue of viewer.pages) {
    const page = record(pageValue);
    const pageIndex = Number(page?.page_idx);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Array.isArray(page?.blocks)) continue;
    pageCount = Math.max(pageCount, pageIndex + 1);
    for (const blockValue of page.blocks) {
      const block = record(blockValue);
      if (!block) continue;
      const id = typeof block.id === "string" ? block.id : "";
      const blockRole = role(block.role);
      const bbox = normalizedBbox(block.bbox_norm);
      if (!id || !blockRole || !bbox) continue;
      const visualId = visualByBlock.get(id) || undefined;
      const candidatePath = typeof block.asset_path === "string" ? block.asset_path.replace(/\\/g, "/") : "";
      const assetPath = blockRole === "visual" && block.source_type === "image" && isSafeRelativePath(candidatePath)
        ? candidatePath
        : undefined;
      blocks.push({
        id,
        pageIndex,
        role: blockRole,
        sourceType: typeof block.source_type === "string" ? block.source_type : "unknown",
        bbox,
        visualId,
        assetPath
      });
    }
  }
  return pageCount && blocks.length ? { pageCount, blocks } : undefined;
}

export function largeCompatibilityImageBlocks(layout: MinerUPdfLayout | undefined, pageNumber: number): MinerUPdfLayoutBlock[] {
  return layout?.blocks.filter((block) => block.pageIndex === pageNumber - 1
    && block.role === "visual"
    && block.sourceType === "image"
    && Boolean(block.assetPath)
    && block.bbox.width * block.bbox.height >= 0.08) ?? [];
}

export function sampledRegionLooksBlank(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  bbox: NormalizedBBox
): boolean {
  if (canvasWidth < 1 || canvasHeight < 1 || pixels.length < canvasWidth * canvasHeight * 4) return false;
  const x0 = Math.max(0, Math.min(canvasWidth - 1, Math.floor(canvasWidth * bbox.x)));
  const y0 = Math.max(0, Math.min(canvasHeight - 1, Math.floor(canvasHeight * bbox.y)));
  const x1 = Math.max(x0 + 1, Math.min(canvasWidth, Math.ceil(canvasWidth * (bbox.x + bbox.width))));
  const y1 = Math.max(y0 + 1, Math.min(canvasHeight, Math.ceil(canvasHeight * (bbox.y + bbox.height))));
  if ((x1 - x0) * (y1 - y0) < canvasWidth * canvasHeight * 0.015) return false;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 48));
  let sampled = 0;
  let ink = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const offset = (y * canvasWidth + x) * 4;
      sampled += 1;
      if (pixels[offset] < 246 || pixels[offset + 1] < 246 || pixels[offset + 2] < 246) ink += 1;
    }
  }
  return sampled >= 64 && ink / sampled < 0.0025;
}
