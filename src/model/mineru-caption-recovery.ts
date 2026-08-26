import { RepairedMinerUVisual } from "./mineru-visual-repair";
import { NormalizedBBox } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

export interface PdfCaptionContinuationBlock {
  sourceBlockId: string;
  start: number;
  end: number;
}

export interface PdfCaptionContinuationRequest {
  visualId: string;
  sourceBlockId: string;
  pageIndex: number;
  bbox: NormalizedBBox;
  anchorText: string;
  candidateBlocks: PdfCaptionContinuationBlock[];
}

export interface RecoveredCaptionContinuation {
  visualId: string;
  sourceBlockId: string;
  anchorText: string;
  continuation: string;
  captionText: string;
  captionStatus: "complete" | "partial";
}

interface CaptionPartEntry {
  block: UnknownRecord;
  text: string;
  kind: string;
  order: number;
}

const MAX_RECOVERY_REQUESTS = 64;
const MAX_TARGET_BLOCK_CHARS = 24_000;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function normalizedBBox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > 1000 || y1 > 1000) return undefined;
  return { x: x0 / 1000, y: y0 / 1000, width: (x1 - x0) / 1000, height: (y1 - y0) / 1000 };
}

function bboxArray(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > 1000 || y1 > 1000) return undefined;
  return [x0, y0, x1, y1];
}

function axisOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function captionAdjacencyScore(captionBbox: [number, number, number, number], visualBbox: [number, number, number, number]): number | undefined {
  const captionWidth = captionBbox[2] - captionBbox[0];
  const visualWidth = visualBbox[2] - visualBbox[0];
  const sharedWidth = axisOverlap(captionBbox[0], captionBbox[2], visualBbox[0], visualBbox[2]);
  const overlapRatio = sharedWidth / Math.max(1, Math.min(captionWidth, visualWidth));
  if (overlapRatio < 0.55) return undefined;
  let gap: number;
  if (captionBbox[1] >= visualBbox[3] - 20) {
    gap = Math.max(0, captionBbox[1] - visualBbox[3]);
    if (gap > 100) return undefined;
  } else if (visualBbox[1] >= captionBbox[3] - 20) {
    gap = Math.max(0, visualBbox[1] - captionBbox[3]);
    if (gap > 80) return undefined;
  } else {
    return undefined;
  }
  return gap + (1 - overlapRatio) * 40;
}

function captionItems(block: UnknownRecord): Array<{ text: string; kind: string }> {
  const caption = record(block.caption);
  if (!Array.isArray(caption?.items)) return [];
  return caption.items.flatMap((value) => {
    const item = record(value);
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const kind = typeof item?.kind === "string" ? item.kind : "other";
    return text ? [{ text, kind }] : [];
  });
}

function captionPartEntries(blocks: UnknownRecord[]): CaptionPartEntry[] {
  let order = 0;
  return [...blocks]
    .sort((left, right) => Number(left.page_order) - Number(right.page_order) || Number(left.source_index) - Number(right.source_index))
    .flatMap((block) => captionItems(block).map((item) => ({ block, ...item, order: order++ })));
}

function endsWithTerminalPunctuation(value: string): boolean {
  let normalized = value.trim();
  while (/<\/[^>]+>\s*$/.test(normalized)) normalized = normalized.replace(/<\/[^>]+>\s*$/, "").trimEnd();
  return /[.!?。！？]["'”’\)\]}]*$/.test(normalized);
}

function figureKeyFromText(value: string): string | undefined {
  const match = /^\s*(?:Fig(?:ure)?\.?|Extended\s+Data\s+Fig(?:ure)?\.?|Supplementary\s+Fig(?:ure)?\.?|Supporting\s+Fig(?:ure)?\.?)\s*([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)/i.exec(value);
  return match?.[1]?.toLocaleLowerCase();
}

function captionPanelMarkers(value: string): Array<{ start: string; end: string }> {
  const markers: Array<{ start: string; end: string }> = [];
  const pattern = /(?:^|[.!?。！？;]\s+)(?:\(([a-z])\)|([a-z])(?:\s*[-–—]\s*([a-z]))?\s*[,;:])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const start = String(match[1] || match[2] || "").toLocaleLowerCase();
    const end = String(match[3] || start).toLocaleLowerCase();
    if (start) markers.push({ start, end });
  }
  return markers;
}

function hasSequentialCaptionPanels(anchorText: string, continuationText: string): boolean {
  const anchorMarkers = captionPanelMarkers(anchorText);
  const continuationMarkers = captionPanelMarkers(continuationText);
  if (!anchorMarkers.length || continuationMarkers.length < 2) return false;
  const lastAnchor = anchorMarkers[anchorMarkers.length - 1].end.charCodeAt(0);
  if (continuationMarkers[0].start.charCodeAt(0) !== lastAnchor + 1) return false;
  let previous = continuationMarkers[0];
  for (const marker of continuationMarkers.slice(1)) {
    const current = marker.start.charCodeAt(0);
    const previousStart = previous.start.charCodeAt(0);
    const previousEnd = previous.end.charCodeAt(0);
    if (!(previousEnd > previousStart && current === previousStart) && current !== previousEnd + 1) return false;
    previous = marker;
  }
  return true;
}

function flattenMinerURecords(raw: unknown): Array<UnknownRecord | undefined> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => Array.isArray(value) ? value : [value]).map(record);
}

function uniqueMarkdownRange(markdown: string, value: string): { start: number; end: number } | undefined {
  if (!value || value.length > MAX_TARGET_BLOCK_CHARS) return undefined;
  const start = markdown.indexOf(value);
  if (start < 0 || markdown.indexOf(value, start + value.length) >= 0) return undefined;
  return { start, end: start + value.length };
}

/**
 * Rebuild the exact bounded recovery requests used by the reference plugin.
 * The request is emitted only for one incomplete formal caption plus one
 * uniquely adjacent empty MinerU text column.
 */
export function collectPdfCaptionContinuationRequests(input: {
  visuals: RepairedMinerUVisual[];
  viewerIndex: unknown;
  mineruPayload: unknown;
  markdown: string;
}): PdfCaptionContinuationRequest[] {
  const viewer = record(input.viewerIndex);
  const pages = Array.isArray(viewer?.pages) ? viewer.pages.map(record).filter((page): page is UnknownRecord => Boolean(page)) : [];
  const blockById = new Map<string, UnknownRecord>();
  const pageByIndex = new Map<number, UnknownRecord>();
  pages.forEach((page) => {
    if (Number.isInteger(page.page_idx)) pageByIndex.set(Number(page.page_idx), page);
    if (!Array.isArray(page.blocks)) return;
    page.blocks.map(record).filter((block): block is UnknownRecord => Boolean(block)).forEach((block) => {
      if (typeof block.id === "string") blockById.set(block.id, block);
    });
  });
  const rawRecords = flattenMinerURecords(input.mineruPayload);
  const markdownRanges = new Map<string, { start: number; end: number }>();
  blockById.forEach((block, id) => {
    const sourceIndex = Number(block.source_index);
    const raw = Number.isInteger(sourceIndex) ? rawRecords[sourceIndex] : undefined;
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    const range = uniqueMarkdownRange(input.markdown, text);
    if (range) markdownRanges.set(id, range);
  });

  const requests: PdfCaptionContinuationRequest[] = [];
  for (const visual of input.visuals) {
    if (requests.length >= MAX_RECOVERY_REQUESTS || !visual.memberBlockIds?.length) break;
    if (visual.captionPageIndex !== undefined) continue;
    const members = visual.memberBlockIds.map((id) => blockById.get(id)).filter((block): block is UnknownRecord => Boolean(block));
    if (members.length !== visual.memberBlockIds.length) continue;
    const entries = captionPartEntries(members);
    const formalEntries = entries.filter((entry) => entry.kind === "formal-caption");
    if (formalEntries.length !== 1) continue;
    const formal = formalEntries[0];
    const formalBbox = bboxArray(formal.block.bbox_norm);
    if (
      !formalBbox
      || endsWithTerminalPunctuation(formal.text)
      || !captionPanelMarkers(formal.text).length
      || entries.some((entry) => entry.order > formal.order && entry.kind === "caption-continuation")
    ) continue;
    const page = pageByIndex.get(visual.pageIndex);
    if (!page || !Array.isArray(page.blocks)) continue;
    const emptyAdjacent = page.blocks.map(record).filter((block): block is UnknownRecord => {
      if (!block || block.id === formal.block.id || block.role !== "text") return false;
      const summary = record(block.text);
      const blockBbox = bboxArray(block.bbox_norm);
      return Boolean(
        blockBbox
        && (!Number(summary?.char_count) || Number(summary?.char_count) === 0)
        && captionAdjacencyScore(blockBbox, formalBbox) !== undefined
      );
    });
    if (emptyAdjacent.length !== 1 || typeof emptyAdjacent[0].id !== "string") continue;
    const recoveryBbox = normalizedBBox(emptyAdjacent[0].bbox_norm);
    if (!recoveryBbox) continue;
    const candidateBlocks: PdfCaptionContinuationBlock[] = [];
    for (const targetPageIndex of [visual.pageIndex, visual.pageIndex - 1]) {
      const targetPage = pageByIndex.get(targetPageIndex);
      if (!targetPage || !Array.isArray(targetPage.blocks)) continue;
      targetPage.blocks.map(record).filter((block): block is UnknownRecord => Boolean(block)).forEach((block) => {
        if (block.role !== "text" || typeof block.id !== "string") return;
        const range = markdownRanges.get(block.id);
        if (range) candidateBlocks.push({ sourceBlockId: block.id, ...range });
      });
    }
    if (!candidateBlocks.length) continue;
    requests.push({
      visualId: visual.id,
      sourceBlockId: emptyAdjacent[0].id,
      pageIndex: visual.pageIndex,
      bbox: recoveryBbox,
      anchorText: formal.text,
      candidateBlocks
    });
  }
  const claims = new Map<string, number>();
  requests.forEach((request) => claims.set(request.sourceBlockId, (claims.get(request.sourceBlockId) ?? 0) + 1));
  return requests.filter((request) => claims.get(request.sourceBlockId) === 1);
}

interface CaptionWordToken {
  value: string;
  start: number;
}

function captionWordTokens(value: string): CaptionWordToken[] {
  const tokens: CaptionWordToken[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) tokens.push({ value: match[0].toLocaleLowerCase(), start: match.index });
  return tokens;
}

function tokenPrefixStart(content: string, recoveredText: string): number {
  const recovered = captionWordTokens(recoveredText);
  const candidate = captionWordTokens(content);
  const prefixLength = Math.min(14, recovered.length);
  if (prefixLength < 7 || candidate.length < prefixLength) return -1;
  const prefix = recovered.slice(0, prefixLength).map((token) => token.value);
  const starts: number[] = [];
  for (let index = 0; index + prefix.length <= candidate.length; index += 1) {
    if (prefix.every((value, offset) => candidate[index + offset].value === value)) starts.push(candidate[index].start);
  }
  return starts.length === 1 ? starts[0] : -1;
}

/** Match PDF text to exactly one suffix in the original Markdown. */
export function recoverPdfCaptionContinuation(
  sourceMarkdown: string,
  request: PdfCaptionContinuationRequest,
  recoveredText: string
): RecoveredCaptionContinuation | undefined {
  const recovered = recoveredText
    .replace(/([\p{L}\p{N}])[-\u00ad]\s+([\p{L}\p{N}])/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (recovered.length < 32 || figureKeyFromText(recovered) || !hasSequentialCaptionPanels(request.anchorText, recovered)) {
    return undefined;
  }
  const matches: string[] = [];
  for (const block of request.candidateBlocks) {
    if (block.start < 0 || block.end <= block.start || block.end > sourceMarkdown.length) continue;
    const content = sourceMarkdown.slice(block.start, block.end).trimEnd();
    const localStart = tokenPrefixStart(content, recovered);
    if (localStart < 0 || localStart >= content.length) continue;
    const continuation = content.slice(localStart).trim();
    if (hasSequentialCaptionPanels(request.anchorText, continuation)) matches.push(continuation);
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return undefined;
  const continuation = unique[0];
  return {
    visualId: request.visualId,
    sourceBlockId: request.sourceBlockId,
    anchorText: request.anchorText,
    continuation,
    captionText: `${request.anchorText.trim()} ${continuation}`.replace(/\s+/g, " ").trim(),
    captionStatus: endsWithTerminalPunctuation(continuation) ? "complete" : "partial"
  };
}

/** Remove one recovered caption suffix only when it occurs exactly once. */
export function suppressRecoveredCaptionContinuation(
  projectedMarkdown: string,
  recovery: RecoveredCaptionContinuation
): string | undefined {
  const exactRange = (text: string) => {
    const start = projectedMarkdown.indexOf(text);
    return start >= 0 && projectedMarkdown.indexOf(text, start + text.length) < 0
      ? { start, end: start + text.length }
      : undefined;
  };
  const ranges = [exactRange(recovery.anchorText), exactRange(recovery.continuation)];
  if (ranges.some((range) => !range)) return undefined;
  return ranges
    .filter((range): range is { start: number; end: number } => Boolean(range))
    .sort((left, right) => right.start - left.start)
    .reduce((result, range) => `${result.slice(0, range.start)}${result.slice(range.end)}`, projectedMarkdown);
}
