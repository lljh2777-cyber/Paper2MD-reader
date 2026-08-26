import { NormalizedBBox } from "./reader-contract";

export interface MinerUTextRecoveryCandidate {
  id: string;
  pageIndex: number;
  bbox: NormalizedBBox;
  sourceText: string;
}

export interface MinerUTextRecoveryResult {
  text: string;
  recoveredCount: number;
}

export interface MinerUParagraphRecoveryAnchor {
  sourceBlockId: string;
  text: string;
  start: number;
  end: number;
}

export interface MinerUParagraphRecoveryRequest {
  id: string;
  sourceBlockId: string;
  pageIndex: number;
  bbox: NormalizedBBox;
  previous: MinerUParagraphRecoveryAnchor;
  next: MinerUParagraphRecoveryAnchor;
}

export interface RecoveredMinerUParagraph {
  sourceBlockId: string;
  previousText: string;
  nextText: string;
  text: string;
}

const MAX_RECOVERY_CANDIDATES = 64;
const MAX_RECOVERY_BLOCK_CHARS = 20_000;
const MAX_REPLACEMENTS_PER_BLOCK = 32;
const MAX_PARAGRAPH_RECOVERY_REQUESTS = 32;
const MAX_RECOVERED_PARAGRAPH_CHARS = 6_000;
const MIN_RECOVERED_PARAGRAPH_CHARS = 48;
const MAX_VIEWER_PAGES = 2_048;
const MAX_VIEWER_BLOCKS_PER_PAGE = 512;
const MAX_INDEXED_VIEWER_BLOCKS = 8_192;

interface IndexedViewerBlock {
  id: string;
  pageIndex: number;
  pageOrder: number;
  sourceIndex: number;
  role: string;
  bbox: NormalizedBBox;
  rawText: string;
  rawType: string;
  captionChars: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedBBox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  const scale = Math.max(...value.map((item) => Math.abs(item as number))) <= 1 ? 1 : 1000;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > scale || y1 > scale) return undefined;
  return { x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale };
}

function uniqueOccurrence(source: string, value: string): boolean {
  const first = source.indexOf(value);
  return first >= 0 && source.indexOf(value, first + value.length) < 0;
}

function uniqueRange(source: string, value: string): { start: number; end: number } | undefined {
  if (!value || value.length > MAX_RECOVERY_BLOCK_CHARS || !uniqueOccurrence(source, value)) return undefined;
  const start = source.indexOf(value);
  return { start, end: start + value.length };
}

function flattenMinerURecords(raw: unknown): Array<Record<string, unknown> | undefined> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => Array.isArray(value) ? value : [value]).map(record);
}

function axisOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function bboxArea(bbox: NormalizedBBox): number {
  return Math.max(0, bbox.width) * Math.max(0, bbox.height);
}

function bboxIntersectionRatio(left: NormalizedBBox, right: NormalizedBBox): number {
  const width = axisOverlap(left.x, left.x + left.width, right.x, right.x + right.width);
  const height = axisOverlap(left.y, left.y + left.height, right.y, right.y + right.height);
  return width * height / Math.max(0.000001, Math.min(bboxArea(left), bboxArea(right)));
}

function verticallyAdjacent(upper: NormalizedBBox, lower: NormalizedBBox): boolean {
  const sharedWidth = axisOverlap(upper.x, upper.x + upper.width, lower.x, lower.x + lower.width);
  const overlapRatio = sharedWidth / Math.max(0.000001, Math.min(upper.width, lower.width));
  const gap = lower.y - (upper.y + upper.height);
  return overlapRatio >= 0.62 && gap >= -0.02 && gap <= 0.12;
}

function validParagraphTarget(bbox: NormalizedBBox): boolean {
  return bbox.x >= 0.02
    && bbox.y >= 0.04
    && bbox.x + bbox.width <= 0.98
    && bbox.y + bbox.height <= 0.96
    && bbox.width >= 0.2
    && bbox.width <= 0.7
    && bbox.height >= 0.025
    && bbox.height <= 0.65;
}

function viewerBlocks(viewerIndex: unknown, mineruPayload: unknown): IndexedViewerBlock[] | undefined {
  const viewer = record(viewerIndex);
  if (!viewer || !Array.isArray(viewer.pages) || viewer.pages.length > MAX_VIEWER_PAGES) return undefined;
  const rawRecords = flattenMinerURecords(mineruPayload);
  if (rawRecords.length > MAX_INDEXED_VIEWER_BLOCKS) return undefined;
  const blocks: IndexedViewerBlock[] = [];
  const ids = new Set<string>();
  const sourceIndexes = new Set<number>();
  const pageIndexes = new Set<number>();
  for (const pageValue of viewer.pages) {
    const page = record(pageValue);
    const pageIndex = Number(page?.page_idx);
    if (
      !page
      || !Number.isInteger(pageIndex)
      || pageIndex < 0
      || pageIndexes.has(pageIndex)
      || !Array.isArray(page.blocks)
      || page.blocks.length > MAX_VIEWER_BLOCKS_PER_PAGE
    ) return undefined;
    pageIndexes.add(pageIndex);
    const pageOrders = new Set<number>();
    for (const blockValue of page.blocks) {
      const block = record(blockValue);
      const id = typeof block?.id === "string" ? block.id.trim() : "";
      const pageOrder = Number(block?.page_order);
      const sourceIndex = Number(block?.source_index);
      const bbox = normalizedBBox(block?.bbox_norm);
      if (
        !block
        || !id
        || ids.has(id)
        || !Number.isInteger(pageOrder)
        || pageOrder < 0
        || pageOrders.has(pageOrder)
        || !Number.isInteger(sourceIndex)
        || sourceIndex < 0
        || sourceIndexes.has(sourceIndex)
        || !bbox
      ) return undefined;
      const raw = rawRecords[sourceIndex];
      if (!raw) return undefined;
      const summary = record(block.text);
      const caption = record(block.caption);
      blocks.push({
        id,
        pageIndex,
        pageOrder,
        sourceIndex,
        role: typeof block.role === "string" ? block.role : "",
        bbox,
        rawText: typeof raw.text === "string" ? raw.text.trim() : "",
        rawType: typeof raw.type === "string" ? raw.type.toLowerCase() : "",
        captionChars: Number(caption?.char_count ?? 0) || 0
      });
      ids.add(id);
      sourceIndexes.add(sourceIndex);
      pageOrders.add(pageOrder);
      if (blocks.length > MAX_INDEXED_VIEWER_BLOCKS) return undefined;
    }
  }
  return blocks.sort((left, right) => left.sourceIndex - right.sourceIndex);
}

function eligibleParagraphAnchor(block: IndexedViewerBlock): boolean {
  return ["text", "title"].includes(block.role)
    && block.rawType === "text"
    && block.captionChars === 0
    && block.rawText.length >= 24
    && block.rawText.length <= MAX_RECOVERY_BLOCK_CHARS
    && !block.rawText.includes("\uFFFD");
}

/**
 * Identify empty MinerU body blocks that are bracketed by two exact Markdown
 * anchors. The PDF text is not trusted yet; it is validated separately after
 * the browser reads only the block bbox from source.pdf.
 */
export function collectMinerUParagraphRecoveryRequests(input: {
  viewerIndex: unknown;
  mineruPayload: unknown;
  markdown: string;
  excludeBlockIds?: readonly string[];
}): MinerUParagraphRecoveryRequest[] {
  const blocks = viewerBlocks(input.viewerIndex, input.mineruPayload);
  if (!blocks) return [];
  const excluded = new Set(input.excludeBlockIds ?? []);
  const targetPageBlocks = new Map<number, IndexedViewerBlock[]>();
  blocks.forEach((block) => {
    const page = targetPageBlocks.get(block.pageIndex) ?? [];
    page.push(block);
    targetPageBlocks.set(block.pageIndex, page);
  });
  const requests: MinerUParagraphRecoveryRequest[] = [];
  for (let index = 1; index + 1 < blocks.length && requests.length < MAX_PARAGRAPH_RECOVERY_REQUESTS; index += 1) {
    const target = blocks[index];
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    if (
      excluded.has(target.id)
      || target.role !== "text"
      || target.rawType !== "text"
      || target.rawText
      || target.captionChars !== 0
      || !validParagraphTarget(target.bbox)
      || !eligibleParagraphAnchor(previous)
      || !eligibleParagraphAnchor(next)
      || Math.abs(previous.pageIndex - target.pageIndex) > 1
      || Math.abs(next.pageIndex - target.pageIndex) > 1
      || (previous.pageIndex !== target.pageIndex && next.pageIndex !== target.pageIndex)
    ) continue;
    const locallyAdjacent = previous.pageIndex === target.pageIndex && verticallyAdjacent(previous.bbox, target.bbox)
      || next.pageIndex === target.pageIndex && verticallyAdjacent(target.bbox, next.bbox);
    if (!locallyAdjacent) continue;
    const overlapsProtectedBlock = (targetPageBlocks.get(target.pageIndex) ?? []).some((block) => (
      block.id !== target.id
      && !["text"].includes(block.role)
      && bboxIntersectionRatio(target.bbox, block.bbox) > 0.08
    ));
    if (overlapsProtectedBlock) continue;
    const previousRange = uniqueRange(input.markdown, previous.rawText);
    const nextRange = uniqueRange(input.markdown, next.rawText);
    if (
      !previousRange
      || !nextRange
      || previousRange.end >= nextRange.start
      || input.markdown.slice(previousRange.end, nextRange.start).trim()
    ) continue;
    requests.push({
      id: `mineru-paragraph-${target.sourceIndex.toString().padStart(6, "0")}`,
      sourceBlockId: target.id,
      pageIndex: target.pageIndex,
      bbox: target.bbox,
      previous: { sourceBlockId: previous.id, text: previous.rawText, ...previousRange },
      next: { sourceBlockId: next.id, text: next.rawText, ...nextRange }
    });
  }
  const gapClaims = new Map<string, number>();
  requests.forEach((request) => {
    const key = `${request.previous.end}:${request.next.start}`;
    gapClaims.set(key, (gapClaims.get(key) ?? 0) + 1);
  });
  return requests.filter((request) => gapClaims.get(`${request.previous.end}:${request.next.start}`) === 1);
}

export function collectMinerUTextRecoveryCandidates(raw: unknown, markdown: string): MinerUTextRecoveryCandidate[] {
  if (!Array.isArray(raw)) return [];
  const candidates: MinerUTextRecoveryCandidate[] = [];
  let sourceIndex = 0;
  const visit = (value: unknown, pageFallback?: number) => {
    const item = record(value);
    if (!item) return;
    const text = typeof item.text === "string" ? item.text : "";
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const pageIndex = Number.isInteger(item.page_idx) && Number(item.page_idx) >= 0
      ? Number(item.page_idx)
      : pageFallback;
    const bbox = normalizedBBox(item.bbox);
    const replacementCount = [...text].filter((character) => character === "\uFFFD").length;
    if (
      candidates.length < MAX_RECOVERY_CANDIDATES
      && type === "text"
      && text.length <= MAX_RECOVERY_BLOCK_CHARS
      && replacementCount > 0
      && replacementCount <= MAX_REPLACEMENTS_PER_BLOCK
      && pageIndex !== undefined
      && bbox
      && uniqueOccurrence(markdown, text)
    ) {
      candidates.push({
        id: `mineru-text-${sourceIndex.toString().padStart(6, "0")}`,
        pageIndex,
        bbox,
        sourceText: text
      });
    }
    sourceIndex += 1;
  };
  if (raw.some(Array.isArray)) {
    raw.forEach((page, pageIndex) => {
      if (Array.isArray(page)) page.forEach((value) => visit(value, pageIndex));
    });
  } else {
    raw.forEach((value) => visit(value));
  }
  return candidates;
}

function regexContext(value: string): string {
  return [...value.replace(/\s+/gu, "")]
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

function safeRecoveredSymbol(value: string): string | undefined {
  let compact = value.replace(/\s+/gu, "");
  const points = [...compact];
  if (points.length >= 2 && points.length % 2 === 0) {
    const half = points.length / 2;
    if (points.slice(0, half).join("") === points.slice(half).join("")) compact = points.slice(0, half).join("");
  }
  const collapsed = [...compact];
  if (collapsed.length < 1 || collapsed.length > 4 || !/^[\p{L}\p{N}\p{S}\p{M}]+$/u.test(compact)) return undefined;
  return compact;
}

function recoverOne(source: string, placeholderIndex: number, pdfText: string): string | undefined {
  const leftSource = [...source.slice(Math.max(0, placeholderIndex - 96), placeholderIndex).replace(/\s+/gu, "")];
  const rightSource = [...source.slice(placeholderIndex + 1, placeholderIndex + 97).replace(/\s+/gu, "")];
  for (const length of [32, 24, 16, 12, 10, 8]) {
    const left = leftSource.slice(-length).join("");
    const right = rightSource.slice(0, length).join("");
    if (left.length < length || right.length < length) continue;
    const expression = new RegExp(`${regexContext(left)}\\s*([\\p{L}\\p{N}\\p{S}\\p{M}\\s]{1,12}?)\\s*${regexContext(right)}`, "gu");
    const matches = [...pdfText.matchAll(expression)];
    if (matches.length !== 1) continue;
    const recovered = safeRecoveredSymbol(matches[0][1]);
    if (recovered) return recovered;
  }
  const rawRight = source.slice(placeholderIndex + 1, placeholderIndex + 97).trimStart();
  if (/^[)\]}]/u.test(rawRight)) {
    const right = [...rawRight.replace(/\s+/gu, "")].slice(0, 28).join("");
    if (right.length >= 16) {
      const expression = new RegExp(`([\\p{L}\\p{N}\\p{S}\\p{M}\\s]{1,12}?)\\s*${regexContext(right)}`, "gu");
      const matches = [...pdfText.matchAll(expression)];
      if (matches.length === 1) return safeRecoveredSymbol(matches[0][1]);
    }
  }
  return undefined;
}

export function recoverReplacementCharacters(sourceText: string, pdfText: string): MinerUTextRecoveryResult | undefined {
  const placeholderIndexes: number[] = [];
  for (let index = sourceText.indexOf("\uFFFD"); index >= 0; index = sourceText.indexOf("\uFFFD", index + 1)) {
    placeholderIndexes.push(index);
  }
  if (!placeholderIndexes.length) return { text: sourceText, recoveredCount: 0 };
  const recovered = placeholderIndexes.map((index) => recoverOne(sourceText, index, pdfText));
  if (recovered.some((value) => !value)) return undefined;
  let cursor = 0;
  let text = "";
  placeholderIndexes.forEach((index, ordinal) => {
    text += sourceText.slice(cursor, index) + recovered[ordinal];
    cursor = index + 1;
  });
  text += sourceText.slice(cursor);
  return { text, recoveredCount: recovered.length };
}

export function applyRecoveredText(article: string, sourceText: string, recoveredText: string): string | undefined {
  if (sourceText === recoveredText || !uniqueOccurrence(article, sourceText)) return undefined;
  return article.replace(sourceText, recoveredText);
}

function normalizedParagraphText(value: string): string {
  return value
    .replace(/\u00ad/gu, "")
    .replace(/([\p{L}\p{N}])[-‐‑]\s+([\p{L}\p{N}])/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(?:[A-Za-z][A-Za-z0-9]+|#\d+|#x[\dA-Fa-f]+);/gu, " ")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function looksLikeCompleteBodyParagraph(value: string): boolean {
  if (
    value.length < MIN_RECOVERED_PARAGRAPH_CHARS
    || value.length > MAX_RECOVERED_PARAGRAPH_CHARS
    || value.includes("\uFFFD")
    || !/^["'“‘(\[]*(?:\p{Lu}|\p{N}\p{L})/u.test(value)
    || !/[.!?。！？]["'”’\)\]}]*$/u.test(value)
    || /^\s*(?:fig(?:ure)?\.?|extended\s+data\s+fig(?:ure)?\.?|supplementary\s+fig(?:ure)?\.?|supporting\s+fig(?:ure)?\.?|table|图|表)\s*[A-Za-z0-9]/iu.test(value)
    || /^\s*(?:article|references|methods|results|discussion|acknowledgements?)\s*[.!?:：]?\s*$/iu.test(value)
  ) return false;
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const visible = value.replace(/\s+/gu, "").length;
  return tokens.length >= 8 && tokens.length <= 1_200 && visible > 0 && letters / visible >= 0.52;
}

/** Validate PDF text against the immutable source Markdown and one bounded gap. */
export function recoverMinerUParagraph(
  sourceMarkdown: string,
  request: MinerUParagraphRecoveryRequest,
  pdfText: string
): RecoveredMinerUParagraph | undefined {
  if (
    request.previous.start < 0
    || request.previous.end <= request.previous.start
    || request.next.start < request.previous.end
    || request.next.end <= request.next.start
    || request.next.end > sourceMarkdown.length
    || sourceMarkdown.slice(request.previous.start, request.previous.end) !== request.previous.text
    || sourceMarkdown.slice(request.next.start, request.next.end) !== request.next.text
    || sourceMarkdown.slice(request.previous.end, request.next.start).trim()
  ) return undefined;
  const text = normalizedParagraphText(pdfText);
  if (!looksLikeCompleteBodyParagraph(text)) return undefined;
  const recoveredEvidence = compactEvidence(text);
  const sourceEvidence = compactEvidence(sourceMarkdown);
  if (recoveredEvidence.length < 32 || sourceEvidence.includes(recoveredEvidence)) return undefined;
  const previousEvidence = compactEvidence(request.previous.text);
  const nextEvidence = compactEvidence(request.next.text);
  if (
    previousEvidence.includes(recoveredEvidence)
    || nextEvidence.includes(recoveredEvidence)
    || recoveredEvidence.includes(previousEvidence)
    || recoveredEvidence.includes(nextEvidence)
  ) return undefined;
  return {
    sourceBlockId: request.sourceBlockId,
    previousText: request.previous.text,
    nextText: request.next.text,
    text
  };
}

function safeMarkdownParagraph(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_\[\]!$])/gu, "\\$1");
}

/** Insert one recovered paragraph into the in-memory projection only. */
export function applyRecoveredParagraph(
  projectedMarkdown: string,
  recovery: RecoveredMinerUParagraph
): string | undefined {
  const previous = uniqueRange(projectedMarkdown, recovery.previousText);
  const next = uniqueRange(projectedMarkdown, recovery.nextText);
  if (!previous || !next || previous.end >= next.start || projectedMarkdown.slice(previous.end, next.start).trim()) {
    return undefined;
  }
  const evidence = compactEvidence(recovery.text);
  if (!evidence || compactEvidence(projectedMarkdown).includes(evidence)) return undefined;
  return `${projectedMarkdown.slice(0, previous.end)}\n\n${safeMarkdownParagraph(recovery.text)}\n\n${projectedMarkdown.slice(next.start)}`;
}
