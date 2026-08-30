import { isSafeRelativePath } from "./contract-validation";
import { MinerUVisual } from "./mineru-content-list";
import { Diagnostic, NormalizedBBox } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

const FIGURE_KEY_RE = /^\s*(extended\s+data\s+fig(?:ure)?|supplementary\s+fig(?:ure)?|supporting(?:\s+information)?\s+fig(?:ure)?|fig(?:ure)?|图)\.?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i;
const FIGURE_REFERENCE_VERBS_RE = /^(?:shows?|illustrates?|depicts?|demonstrates?|presents?|reports?|displays?|compares?|lists?|summari[sz]es?|gives?|provides?|plots?|is|are|was|were)\b/i;

export interface RepairedMinerUVisual extends MinerUVisual {
  /** Display-only navigation suppression for proven non-article artifacts. Source files stay unchanged. */
  hidden?: boolean;
  memberAssetPaths?: string[];
  memberBlockIds?: string[];
  memberMarkdownImageIds?: string[];
  captionSourceRanges?: Array<{ start: number; end: number; text: string }>;
  captionPageIndex?: number;
  captionStatus?: "complete" | "partial";
  panelLabels?: string[];
  display?:
    | { mode: "asset" }
    | { mode: "pdf-crop"; pdfPath: string; bbox: NormalizedBBox; padding: number }
    | { mode: "fragment-set"; fragments: Array<{ path: string; bbox: NormalizedBBox }> };
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function hashMatches(value: unknown, articleHash: string, mineruHash: string): boolean {
  const inputs = record(value);
  const article = record(inputs?.article);
  const mineru = record(inputs?.mineru_result);
  return article?.sha256 === articleHash && mineru?.sha256 === mineruHash;
}

function bbox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > 1000 || y1 > 1000) return undefined;
  return { x: x0 / 1000, y: y0 / 1000, width: (x1 - x0) / 1000, height: (y1 - y0) / 1000 };
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

interface CaptionPartEntry {
  block: UnknownRecord;
  text: string;
  kind: string;
  order: number;
}

interface MarkdownImageOccurrence {
  id: string;
  assetPath: string;
  start: number;
  end: number;
}

interface MarkdownLineRange {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
}

function captionPartEntries(blocks: UnknownRecord[]): CaptionPartEntry[] {
  let order = 0;
  return [...blocks]
    .sort((left, right) => Number(left.page_order) - Number(right.page_order) || Number(left.source_index) - Number(right.source_index))
    .flatMap((block) => captionItems(block).map((item) => ({ block, ...item, order: order++ })));
}

function endsWithTerminalPunctuation(value: string): boolean {
  let normalized = value.trim();
  while (/<\/[^>]+>\s*$/.test(normalized)) {
    normalized = normalized.replace(/<\/[^>]+>\s*$/, "").trimEnd();
  }
  return /[.!?。！？]["'”’\)\]}]*$/.test(normalized);
}

function startsWithPanelLabel(value: string): boolean {
  return /^\s*[a-z](?:\s*[-–—]\s*[a-z])?[\s,.;:)]/i.test(value);
}

function firstAlphaIsLowercase(value: string): boolean {
  for (const character of value) {
    if (!/\p{L}/u.test(character)) continue;
    return character === character.toLowerCase() && character !== character.toUpperCase();
  }
  return false;
}

function sourceStartsLikeCaptionContinuation(value: string | undefined): boolean {
  return Boolean(value && (
    firstAlphaIsLowercase(value)
    || /^\s*[\[(]?[A-Za-z][\])\].:]?(?=\s|[,;:])/.test(value)
  ));
}

function formalFigureKeyFromText(value: string): string | undefined {
  return FIGURE_KEY_RE.exec(value)?.[2]?.toLowerCase();
}

function formalFigureMetadataKeyFromText(value: string): string | undefined {
  const match = FIGURE_KEY_RE.exec(value);
  if (!match) return undefined;
  const remainder = value.slice(match[0].length);
  const delimited = /^\s*[|｜:：.]\s*([^|｜:：.\s][\s\S]*)$/.exec(remainder);
  const undelimited = /^\s+([^|｜:：.\s][\s\S]*)$/.exec(remainder);
  const title = (delimited?.[1] ?? undelimited?.[1] ?? "").trim();
  if (title.length < 5 || FIGURE_REFERENCE_VERBS_RE.test(title)) return undefined;
  const rawKind = match[1].trim().toLowerCase().replace(/\s+/g, " ");
  const kind = rawKind.startsWith("extended data")
    ? "extended-data-figure"
    : rawKind.startsWith("supplementary")
      ? "supplementary-figure"
      : rawKind.startsWith("supporting")
        ? "supporting-figure"
        : rawKind === "图" ? "图" : "figure";
  return `${kind}:${match[2].trim().toLowerCase().replace(/\./g, "_")}`;
}

function sourceBoundFormalCaption(
  block: UnknownRecord,
  sourceTextByBlockId: Map<string, string>
): { key: string; terminal: boolean } | undefined {
  const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id) : undefined;
  if (!source) return undefined;
  const sourceKey = formalFigureMetadataKeyFromText(source);
  if (!sourceKey) return undefined;
  const summary = record(block.text);
  const caption = record(block.caption);
  const metadataKeys = [...new Set([
    ...strings(summary?.formal_figure_caption_keys),
    ...strings(caption?.formal_figure_caption_keys),
    typeof summary?.leading_formal_figure_caption_key === "string" ? summary.leading_formal_figure_caption_key : "",
    typeof caption?.leading_formal_figure_caption_key === "string" ? caption.leading_formal_figure_caption_key : ""
  ].filter(Boolean).map((key) => key.toLowerCase()))];
  const sourceTerminal = endsWithTerminalPunctuation(source);
  if (
    metadataKeys.length !== 1
    || metadataKeys[0] !== sourceKey
    || typeof summary?.ends_with_terminal_punctuation !== "boolean"
    || summary.ends_with_terminal_punctuation !== sourceTerminal
  ) return undefined;
  return { key: sourceKey, terminal: sourceTerminal };
}

function captionPanelMarkers(value: string): Array<{ start: string; end: string }> {
  const markers: Array<{ start: string; end: string }> = [];
  const pattern = /(?:^|[.!?。！？;]\s+)(?:\(([a-z])\)|([a-z])(?:\s*[-–—]\s*([a-z]))?\s*[,;:])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const start = String(match[1] || match[2] || "").toLowerCase();
    const end = String(match[3] || start).toLowerCase();
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

function decodedMarkdownPath(value: string): string | undefined {
  let decoded = value.trim().replace(/^<|>$/g, "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return undefined;
  }
  const path = decoded.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/^\.\//, "");
  return isSafeRelativePath(path) ? path : undefined;
}

function markdownImagePath(token: string): string | undefined {
  const markdown = /^!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)$/s.exec(token);
  const html = /^<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>$/is.exec(token);
  return decodedMarkdownPath(markdown?.[1] || markdown?.[2] || html?.[1] || "");
}

function markdownImageOccurrences(viewer: UnknownRecord, markdown: string): Map<string, MarkdownImageOccurrence> {
  const result = new Map<string, MarkdownImageOccurrence>();
  if (!Array.isArray(viewer.markdown_images)) return result;
  for (const value of viewer.markdown_images) {
    const image = record(value);
    if (
      typeof image?.id !== "string"
      || typeof image.asset_path !== "string"
      || !Number.isInteger(image.char_start)
      || !Number.isInteger(image.char_end)
      || result.has(image.id)
    ) continue;
    const start = Number(image.char_start);
    const end = Number(image.char_end);
    const assetPath = decodedMarkdownPath(image.asset_path);
    if (start < 0 || end <= start || end > markdown.length || !assetPath) continue;
    if (markdownImagePath(markdown.slice(start, end)) !== assetPath) continue;
    result.set(image.id, { id: image.id, assetPath, start, end });
  }
  return result;
}

function previousMarkdownLine(markdown: string, lineStart: number): MarkdownLineRange | undefined {
  if (lineStart <= 0) return undefined;
  const contentEnd = lineStart - 1;
  const previousNewline = markdown.lastIndexOf("\n", Math.max(0, contentEnd - 1));
  const start = previousNewline + 1;
  return { start, contentEnd, end: lineStart, text: markdown.slice(start, contentEnd).replace(/\r$/, "") };
}

function nextMarkdownLine(markdown: string, lineStart: number): MarkdownLineRange | undefined {
  if (lineStart >= markdown.length) return undefined;
  const newline = markdown.indexOf("\n", lineStart);
  const contentEnd = newline < 0 ? markdown.length : newline;
  return {
    start: lineStart,
    contentEnd,
    end: newline < 0 ? markdown.length : newline + 1,
    text: markdown.slice(lineStart, contentEnd).replace(/\r$/, "")
  };
}

function nearbyNonBlankLines(markdown: string, lineStart: number, limit: number, direction: "before" | "after"): MarkdownLineRange[] {
  const lines: MarkdownLineRange[] = [];
  let cursor = lineStart;
  let blankCount = 0;
  while (lines.length < limit) {
    const line = direction === "before" ? previousMarkdownLine(markdown, cursor) : nextMarkdownLine(markdown, cursor);
    if (!line) break;
    cursor = direction === "before" ? line.start : line.end;
    if (!line.text.trim()) {
      blankCount += 1;
      if (blankCount > 2) break;
      continue;
    }
    blankCount = 0;
    lines.push(line);
  }
  return lines;
}

function adjacentCaptionRanges(
  markdown: string,
  occurrence: MarkdownImageOccurrence,
  parts: readonly string[]
): Array<{ start: number; end: number; text: string }> | undefined {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (!normalized.length || normalized.some((part) => /[\r\n]/.test(part))) return undefined;
  const imageLineStart = markdown.lastIndexOf("\n", Math.max(0, occurrence.start - 1)) + 1;
  const imageNewline = markdown.indexOf("\n", occurrence.end);
  const imageLineEnd = imageNewline < 0 ? markdown.length : imageNewline;
  if (markdown.slice(imageLineStart, occurrence.start).trim() || markdown.slice(occurrence.end, imageLineEnd).trim()) {
    return undefined;
  }
  const previous = nearbyNonBlankLines(markdown, imageLineStart, normalized.length, "before");
  const next = nearbyNonBlankLines(markdown, imageNewline < 0 ? markdown.length : imageNewline + 1, normalized.length, "after");
  const matches: Array<{ beforeCount: number; afterCount: number }> = [];
  for (let beforeCount = 0; beforeCount <= normalized.length; beforeCount += 1) {
    const afterCount = normalized.length - beforeCount;
    const beforeMatches = previous.length >= beforeCount
      && previous.slice(0, beforeCount).reverse().every((line, index) => line.text.trim() === normalized[index]);
    const afterMatches = next.length >= afterCount
      && next.slice(0, afterCount).every((line, index) => line.text.trim() === normalized[beforeCount + index]);
    if (beforeMatches && afterMatches) matches.push({ beforeCount, afterCount });
  }
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const lines = [
    ...previous.slice(0, match.beforeCount).reverse(),
    ...next.slice(0, match.afterCount)
  ];
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = normalized[index];
    const localIndex = lines[index].text.indexOf(text);
    if (localIndex < 0 || lines[index].text.indexOf(text, localIndex + text.length) >= 0) return undefined;
    ranges.push({ start: lines[index].start + localIndex, end: lines[index].start + localIndex + text.length, text });
  }
  return ranges;
}

function samePageCaptionDetails(
  blocks: UnknownRecord[],
  viewer: UnknownRecord,
  markdown: string
): {
  caption: string;
  captionSourceRanges: Array<{ start: number; end: number; text: string }>;
  captionStatus: "complete";
} | undefined {
  const entries = captionPartEntries(blocks);
  const formalEntries = entries.filter((entry) => entry.kind === "formal-caption");
  if (formalEntries.length !== 1) return undefined;
  const formal = formalEntries[0];
  const safeContinuation = (entry: CaptionPartEntry): boolean => entry.order > formal.order
    && (entry.kind === "caption-continuation" || (
      entry.kind === "other"
      && !endsWithTerminalPunctuation(formal.text)
      && hasSequentialCaptionPanels(formal.text, entry.text)
    ))
    && entry.text.length >= 24
    && !formalFigureKeyFromText(entry.text)
    && endsWithTerminalPunctuation(entry.text);
  const sameBlockLater = entries.filter((entry) => entry.block === formal.block && entry.order > formal.order);
  const sameBlockChain: CaptionPartEntry[] = [];
  for (const entry of sameBlockLater) {
    if (!safeContinuation(entry)) break;
    sameBlockChain.push(entry);
  }
  const crossBlock = !endsWithTerminalPunctuation(formal.text)
    ? entries.filter((entry) => entry.block !== formal.block && safeContinuation(entry))
    : [];
  const continuations = !endsWithTerminalPunctuation(formal.text) && sameBlockChain.length
    ? sameBlockChain
    : endsWithTerminalPunctuation(formal.text) && sameBlockChain.length && startsWithPanelLabel(sameBlockChain[0].text)
      ? sameBlockChain
      : crossBlock.length === 1
        ? crossBlock
        : [];
  if (!endsWithTerminalPunctuation(formal.text) && continuations.length === 0) return undefined;
  const selected = [formal, ...continuations];
  const occurrences = markdownImageOccurrences(viewer, markdown);
  const byBlock = new Map<UnknownRecord, CaptionPartEntry[]>();
  selected.forEach((entry) => byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry]));
  const projected: Array<{ entry: CaptionPartEntry; range: { start: number; end: number; text: string } }> = [];
  for (const [block, blockEntries] of byBlock) {
    const ids = strings(block.markdown_image_ids);
    const assetPath = typeof block.asset_path === "string" ? decodedMarkdownPath(block.asset_path) : undefined;
    if (ids.length !== 1 || !assetPath) return undefined;
    const occurrence = occurrences.get(ids[0]);
    if (!occurrence || occurrence.assetPath !== assetPath) return undefined;
    const ranges = adjacentCaptionRanges(markdown, occurrence, blockEntries.map((entry) => entry.text));
    if (!ranges || ranges.length !== blockEntries.length) return undefined;
    blockEntries.forEach((entry, index) => projected.push({ entry, range: ranges[index] }));
  }
  projected.sort((left, right) => left.entry.order - right.entry.order);
  if (projected.some((entry, index) => index > 0 && entry.range.start <= projected[index - 1].range.end)) return undefined;
  return {
    caption: selected.map((entry) => entry.text).join(" ").replace(/\s+/g, " ").trim(),
    captionSourceRanges: projected.map((entry) => entry.range),
    captionStatus: "complete"
  };
}

function samePagePanelLabelRanges(
  blocks: UnknownRecord[],
  viewer: UnknownRecord,
  markdown: string
): Array<{ start: number; end: number; text: string }> {
  const entries = captionPartEntries(blocks).filter((entry) => entry.kind === "panel-label");
  const occurrences = markdownImageOccurrences(viewer, markdown);
  const byBlock = new Map<UnknownRecord, CaptionPartEntry[]>();
  entries.forEach((entry) => byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry]));
  const result: Array<{ start: number; end: number; text: string }> = [];
  for (const [block, blockEntries] of byBlock) {
    const ids = strings(block.markdown_image_ids);
    const assetPath = typeof block.asset_path === "string" ? decodedMarkdownPath(block.asset_path) : undefined;
    if (ids.length !== 1 || !assetPath) continue;
    const occurrence = occurrences.get(ids[0]);
    if (!occurrence || occurrence.assetPath !== assetPath) continue;
    const ranges = adjacentCaptionRanges(markdown, occurrence, blockEntries.map((entry) => entry.text));
    if (ranges?.length === blockEntries.length) result.push(...ranges);
  }
  return result.sort((left, right) => left.start - right.start);
}

function nextPagePlaceholderRanges(
  blocks: UnknownRecord[],
  viewer: UnknownRecord,
  markdown: string
): Array<{ start: number; end: number; text: string }> {
  if (!markdown) return [];
  const placeholders = captionPartEntries(blocks).filter((entry) => (
    (entry.kind === "next-page-placeholder" || entry.kind === "formal-caption")
    && record(entry.block.caption)?.next_page_marker === true
  ));
  const occurrences = markdownImageOccurrences(viewer, markdown);
  const byBlock = new Map<UnknownRecord, CaptionPartEntry[]>();
  placeholders.forEach((entry) => byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry]));
  const result: Array<{ start: number; end: number; text: string }> = [];
  for (const [block, blockPlaceholders] of byBlock) {
    if (blockPlaceholders.length !== 1) continue;
    const ids = strings(block.markdown_image_ids);
    const assetPath = typeof block.asset_path === "string" ? decodedMarkdownPath(block.asset_path) : undefined;
    if (ids.length !== 1 || !assetPath) continue;
    const occurrence = occurrences.get(ids[0]);
    if (!occurrence || occurrence.assetPath !== assetPath) continue;
    // MinerU often places panel labels between the next-page marker and the
    // associated image. Match the complete local sequence so the marker is
    // still required to be structurally adjacent, then suppress only the
    // marker. Panel labels are handled by samePagePanelLabelRanges.
    const localEntries = captionPartEntries([block]).filter((entry) => (
      entry.kind === "panel-label"
      || entry.kind === "next-page-placeholder"
      || (entry.kind === "formal-caption" && record(entry.block.caption)?.next_page_marker === true)
    ));
    const ranges = adjacentCaptionRanges(markdown, occurrence, localEntries.map((entry) => entry.text));
    if (!ranges || ranges.length !== localEntries.length) continue;
    localEntries.forEach((entry, index) => {
      if (
        entry.text === blockPlaceholders[0].text
        && (entry.kind === "next-page-placeholder" || entry.kind === "formal-caption")
      ) result.push(ranges[index]);
    });
  }
  return result.sort((left, right) => left.start - right.start);
}

function uniqueSourceRanges(
  ...groups: Array<Array<{ start: number; end: number; text: string }>>
): Array<{ start: number; end: number; text: string }> {
  const unique = new Map<string, { start: number; end: number; text: string }>();
  groups.flat().forEach((range) => unique.set(`${range.start}:${range.end}:${range.text}`, range));
  return [...unique.values()].sort((left, right) => left.start - right.start);
}

function bestCaption(blocks: UnknownRecord[], visuals: MinerUVisual[]): string | undefined {
  const items = blocks.flatMap(captionItems);
  const formal = items.filter((item) => item.kind === "formal-caption").map((item) => item.text);
  const candidates = formal.length
    ? formal
    : [...items.map((item) => item.text), ...visuals.map((visual) => visual.captionText ?? "")];
  return [...new Set(candidates.filter(Boolean))].sort((left, right) => right.length - left.length)[0];
}

function blockCaptionText(block: UnknownRecord | undefined): string {
  if (!block) return "";
  const items = captionItems(block).map((item) => item.text);
  const text = record(block.text);
  if (typeof text?.text === "string" && text.text.trim()) items.push(text.text.trim());
  return [...new Set(items.filter(Boolean))].sort((left, right) => right.length - left.length)[0] ?? "";
}

function panelLabels(blocks: UnknownRecord[]): string[] {
  return [...new Set(blocks.flatMap(captionItems)
    .filter((item) => item.kind === "panel-label")
    .map((item) => item.text.trim())
    .filter(Boolean))];
}

function markdownRange(
  block: UnknownRecord | undefined,
  sourceText?: string,
  articleMarkdown?: string
): { start: number; end: number; text: string } | undefined {
  if (!block) return undefined;
  const range = record(block.markdown_text_range);
  const text = record(block.text);
  if (
    range?.offset_unit !== "utf16-code-unit"
    || !Number.isInteger(range.start)
    || !Number.isInteger(range.end)
    || Number(range.start) < 0
    || Number(range.end) <= Number(range.start)
  ) {
    if (!sourceText || !articleMarkdown) return undefined;
    const start = articleMarkdown.indexOf(sourceText);
    if (start < 0 || articleMarkdown.indexOf(sourceText, start + sourceText.length) >= 0) return undefined;
    return { start, end: start + sourceText.length, text: sourceText };
  }
  const rangeText = typeof text?.text === "string" && text.text.trim() ? text.text : sourceText;
  if (!rangeText) return undefined;
  if (articleMarkdown && articleMarkdown.slice(Number(range.start), Number(range.end)).trim() !== rangeText.trim()) return undefined;
  return { start: Number(range.start), end: Number(range.end), text: rangeText };
}

function labelFromCaption(caption: string | undefined, fallback: string): string {
  const match = caption?.match(/^\s*((?:Fig(?:ure)?\.?|Extended Data Fig(?:ure)?\.?|Supplementary Fig(?:ure)?\.?|Table)\s*[A-Za-z0-9._-]+)/i);
  return match?.[1].trim().replace(/[.:;-]+$/, "") || fallback;
}

function normalizedBboxArray(value: unknown): [number, number, number, number] | undefined {
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

function sameTopCaptionBand(anchor: UnknownRecord, candidate: UnknownRecord): boolean {
  const anchorBbox = normalizedBboxArray(anchor.bbox_norm);
  const candidateBbox = normalizedBboxArray(candidate.bbox_norm);
  if (!anchorBbox || !candidateBbox) return false;
  const [ax0, ay0, ax1, ay1] = anchorBbox;
  const [cx0, cy0, cx1, cy1] = candidateBbox;
  if (Math.abs(ay0 - cy0) > 45 || axisOverlap(ax0, ax1, cx0, cx1) > 0) return false;
  const xGap = Math.max(0, Math.max(ax0, cx0) - Math.min(ax1, cx1));
  if (xGap > 80) return false;
  const anchorHeight = ay1 - ay0;
  const candidateHeight = cy1 - cy0;
  const yOverlap = axisOverlap(ay0, ay1, cy0, cy1);
  if (yOverlap < 0.55 * Math.min(anchorHeight, candidateHeight)) return false;
  const heightRatio = candidateHeight / anchorHeight;
  return heightRatio >= 0.45 && heightRatio <= 2.2;
}

function blockCharCount(block: UnknownRecord): number {
  const value = record(block.text)?.char_count;
  return Number.isInteger(value) ? Math.max(0, Number(value)) : 0;
}

function runningPageHeader(block: UnknownRecord): boolean {
  if (block.role !== "title" || blockCharCount(block) <= 0 || blockCharCount(block) > 16) return false;
  const blockBbox = normalizedBboxArray(block.bbox_norm);
  const text = record(block.text) ?? {};
  return Boolean(
    blockBbox
    && blockBbox[0] <= 200
    && blockBbox[1] <= 40
    && blockBbox[2] - blockBbox[0] <= 180
    && blockBbox[3] <= 65
    && !text.leading_figure_key
    && !text.leading_formal_figure_caption_key
  );
}

function terminalCaptionSource(block: UnknownRecord, sourceTextByBlockId: Map<string, string>): boolean {
  const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id)?.trim() : undefined;
  return Boolean(source && endsWithTerminalPunctuation(source));
}

function hasFormalCaption(block: UnknownRecord): boolean {
  const caption = record(block.caption);
  const text = record(block.text);
  return strings(caption?.formal_figure_caption_keys).length > 0
    || strings(text?.formal_figure_caption_keys).length > 0
    || Boolean(caption?.leading_formal_figure_caption_key)
    || Boolean(text?.leading_formal_figure_caption_key);
}

function rawTypeMatchesRole(role: unknown, raw: UnknownRecord): boolean {
  const type = String(raw.type ?? "unknown").trim().toLowerCase();
  if (role === "visual") return type === "image" || type === "chart";
  if (role === "table") return type === "table" || type === "table_body";
  if (role === "equation") return type === "equation" || type === "interline_equation";
  if (role === "title") return type === "title" || type === "paragraph_title"
    || (type === "text" && raw.text_level !== null && raw.text_level !== undefined);
  if (role === "text") return ["text", "paragraph", "ref_text", "list"].includes(type)
    && !(type === "text" && raw.text_level !== null && raw.text_level !== undefined);
  if (role === "marginalia") return [
    "aside_text", "footer", "header", "page_footer", "page_footnote", "page_header", "page_number"
  ].includes(type);
  return role === "other";
}

function sameNormalizedBbox(left: unknown, right: unknown): boolean {
  const a = normalizedBboxArray(left);
  const b = normalizedBboxArray(right);
  return Boolean(a && b && a.every((value, index) => value === b![index]));
}

function stringSetEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size
    && right.length === new Set(right).size
    && left.length === right.length
    && left.every((value) => right.includes(value));
}

function expandedCaptionPanelLabels(value: string): Set<string> {
  const labels = new Set<string>();
  captionPanelMarkers(value).forEach(({ start, end }) => {
    const first = start.charCodeAt(0);
    const last = end.charCodeAt(0);
    if (first < 97 || first > 122 || last < first || last > 122) return;
    for (let code = first; code <= last; code += 1) labels.add(String.fromCharCode(code));
  });
  return labels;
}

function footerBadgeGeometry(block: UnknownRecord): boolean {
  if (block.role !== "visual" || captionItems(block).length || hasFormalCaption(block)) return false;
  const caption = record(block.caption);
  const text = record(block.text);
  const blockBbox = normalizedBboxArray(block.bbox_norm);
  if (
    !blockBbox
    || caption?.next_page_marker === true
    || strings(caption?.next_page_figure_keys).length
    || text?.leading_figure_key
    || text?.leading_formal_figure_caption_key
  ) return false;
  const width = blockBbox[2] - blockBbox[0];
  const height = blockBbox[3] - blockBbox[1];
  return blockBbox[1] >= 700 && width <= 100 && height <= 35 && width * height <= 2_500;
}

export function applyMinerUVisualRepair(input: {
  visuals: MinerUVisual[];
  viewerIndex: unknown;
  visualRepair: unknown;
  mineruPayload?: unknown;
  articleMarkdown?: string;
  articleHash: string;
  mineruHash: string;
  sourcePdfPath?: string;
}): { visuals: RepairedMinerUVisual[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const viewer = record(input.viewerIndex);
  const repair = record(input.visualRepair);
  if (
    viewer?.schema_version !== 1
    || repair?.schema_version !== 1
    || !hashMatches(viewer.inputs, input.articleHash, input.mineruHash)
    || !hashMatches(repair.inputs, input.articleHash, input.mineruHash)
  ) {
    diagnostics.push({
      level: "warning",
      code: "mineru-visual-repair-binding-invalid",
      message: "视觉修复契约与当前 MinerU 原文不匹配，已保留原始图片显示。"
    });
    return { visuals: input.visuals, diagnostics };
  }

  const pages = Array.isArray(viewer.pages) ? viewer.pages : [];
  const blockById = new Map<string, UnknownRecord>();
  const pageByBlockId = new Map<string, number>();
  const sourceIndexes = new Set<number>();
  const pageIndexes = new Set<number>();
  let contractStructureSafe = true;
  let runtimeInferenceSafe = true;
  pages.forEach((pageValue) => {
    const page = record(pageValue);
    if (!page || !Number.isInteger(page.page_idx) || pageIndexes.has(Number(page.page_idx)) || !Array.isArray(page.blocks)) {
      contractStructureSafe = false;
      runtimeInferenceSafe = false;
      return;
    }
    pageIndexes.add(Number(page.page_idx));
    page.blocks.forEach((blockValue) => {
      const block = record(blockValue);
      if (typeof block?.id === "string") {
        if (blockById.has(block.id)) {
          contractStructureSafe = false;
          runtimeInferenceSafe = false;
        }
        blockById.set(block.id, block);
        pageByBlockId.set(block.id, Number(page.page_idx));
      } else {
        contractStructureSafe = false;
        runtimeInferenceSafe = false;
      }
      const sourceIndex = Number(block?.source_index);
      if (!Number.isInteger(sourceIndex) || sourceIndexes.has(sourceIndex)) {
        contractStructureSafe = false;
        runtimeInferenceSafe = false;
      }
      else sourceIndexes.add(sourceIndex);
    });
  });
  const visualByPath = new Map(input.visuals.map((visual) => [visual.path, visual]));
  if (visualByPath.size !== input.visuals.length) {
    contractStructureSafe = false;
    runtimeInferenceSafe = false;
  }
  if (Array.isArray(viewer.markdown_images)) {
    const markdownIds = viewer.markdown_images.map(record).map((image) => image?.id).filter((id): id is string => typeof id === "string");
    if (markdownIds.length !== viewer.markdown_images.length || new Set(markdownIds).size !== markdownIds.length) {
      contractStructureSafe = false;
      runtimeInferenceSafe = false;
    }
  }
  const orderByPath = new Map(input.visuals.map((visual, index) => [visual.path, index]));
  const consumed = new Set<string>();
  const repaired: Array<{ order: number; visual: RepairedMinerUVisual }> = [];
  const rawGroups = Array.isArray(repair.groups) ? repair.groups : [];
  const captionLinks = Array.isArray(repair.caption_links) ? repair.caption_links : [];
  const rawRecords = Array.isArray(input.mineruPayload)
    ? input.mineruPayload.flatMap((value) => Array.isArray(value) ? value : [value]).map(record)
    : [];
  const sourceTextByBlockId = new Map<string, string>();
  let sourceBindingSafe = true;
  blockById.forEach((block, id) => {
    const sourceIndex = Number(block.source_index);
    const raw = Number.isInteger(sourceIndex) ? rawRecords[sourceIndex] : undefined;
    const pageIndex = pageByBlockId.get(id);
    const rawAssetPath = typeof raw?.img_path === "string" && raw.img_path.trim()
      ? raw.img_path.replace(/\\/g, "/")
      : undefined;
    const blockAssetPath = typeof block.asset_path === "string" && block.asset_path.trim()
      ? block.asset_path.replace(/\\/g, "/")
      : undefined;
    const sourceBound = Boolean(
      raw
      && pageIndex !== undefined
      && Number(raw.page_idx) === pageIndex
      && rawTypeMatchesRole(block.role, raw)
      && sameNormalizedBbox(block.bbox_norm, raw.bbox)
      && (blockAssetPath === undefined || rawAssetPath === blockAssetPath)
    );
    if (!sourceBound) {
      sourceBindingSafe = false;
      runtimeInferenceSafe = false;
      return;
    }
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (text) sourceTextByBlockId.set(id, text);
  });
  if (!contractStructureSafe || !sourceBindingSafe) {
    diagnostics.push({
      level: "warning",
      code: "mineru-viewer-source-binding-invalid",
      message: "Viewer 派生块无法与原始 MinerU 页码、类型、坐标和资源建立唯一绑定，已保留原始图片显示。"
    });
    return { visuals: input.visuals, diagnostics };
  }
  let fullPageConsolidationCount = 0;
  const consolidatedPages = new Set<number>();
  const syntheticGroups: UnknownRecord[] = [];
  const rawGroupRecords = rawGroups.map(record).filter((group): group is UnknownRecord => Boolean(group));
  const pageRecords = pages.map(record).filter((page): page is UnknownRecord => Boolean(page));
  const runtimeGroupIds = rawGroupRecords.map((group) => group.id).filter((id): id is string => typeof id === "string");
  if (runtimeGroupIds.length !== rawGroupRecords.length || new Set(runtimeGroupIds).size !== runtimeGroupIds.length) {
    diagnostics.push({
      level: "warning",
      code: "mineru-visual-group-binding-invalid",
      message: "视觉修复组标识不唯一，已保留原始图片显示。"
    });
    return { visuals: input.visuals, diagnostics };
  }
  const groupSupportsRuntimeInference = (group: UnknownRecord, pageIndex: number): boolean => {
    const ids = strings(group.member_block_ids);
    const paths = strings(group.member_asset_paths);
    const markdownIds = strings(group.member_markdown_image_ids);
    const blocks = ids.map((id) => blockById.get(id));
    const expectedPaths = blocks.flatMap((block) => typeof block?.asset_path === "string" ? [block.asset_path] : []);
    const expectedMarkdownIds = blocks.flatMap((block) => block ? strings(block.markdown_image_ids) : []);
    const replacement = record(group.replacement);
    const confidence = Number(group.confidence);
    return Number(group.page_idx) === pageIndex
      && group.decision === "auto"
      && ids.length >= 2
      && blocks.every((block) => Boolean(
        block
        && ["visual", "table"].includes(String(block.role))
        && typeof block.id === "string"
        && pageByBlockId.get(block.id) === pageIndex
      ))
      && stringSetEquals(ids, ids)
      && stringSetEquals(paths, expectedPaths)
      && stringSetEquals(markdownIds, expectedMarkdownIds)
      && Number.isFinite(confidence)
      && confidence >= 0
      && confidence <= 1
      && replacement?.mode === "pdf_crop"
      && Boolean(normalizedBboxArray(replacement.bbox_norm));
  };
  const pageSourceCaptionDetails = (
    memberIds: string[],
    pageIndex: number,
    requireCaptionOnlyPage = false
  ): {
    caption: string;
    captionBlocks: UnknownRecord[];
    captionSourceRanges: Array<{ start: number; end: number; text: string }>;
    captionStatus: "complete";
  } | undefined => {
    if (!input.articleMarkdown || !memberIds.length) return undefined;
    const page = pageRecords.find((candidate) => Number(candidate.page_idx) === pageIndex);
    if (!Array.isArray(page?.blocks)) return undefined;
    const ordered = page.blocks.map(record)
      .filter((block): block is UnknownRecord => Boolean(block))
      .sort((left, right) => Number(left.page_order) - Number(right.page_order) || Number(left.source_index) - Number(right.source_index));
    const pageVisuals = ordered.filter((block) => ["visual", "table"].includes(String(block.role)));
    if (pageVisuals.some((block) => (
      typeof block.id !== "string"
      || typeof block.asset_path !== "string"
      || !visualByPath.has(block.asset_path)
    ))) return undefined;
    const pageVisualIds = pageVisuals.map((block) => String(block.id));
    const memberSet = new Set(memberIds);
    if (
      memberSet.size !== memberIds.length
      || pageVisualIds.length !== memberSet.size
      || pageVisualIds.some((id) => !memberSet.has(id))
    ) return undefined;
    const memberBoxes = pageVisuals.map((block) => normalizedBboxArray(block.bbox_norm));
    if (memberBoxes.some((value) => !value)) return undefined;
    const exactMemberBoxes = memberBoxes.filter((value): value is [number, number, number, number] => Boolean(value));
    const visualLeft = Math.min(...exactMemberBoxes.map((value) => value[0]));
    const visualRight = Math.max(...exactMemberBoxes.map((value) => value[2]));
    const visualBottom = Math.max(...exactMemberBoxes.map((value) => value[3]));
    const formal = ordered.filter((block) => {
      const blockBbox = normalizedBboxArray(block.bbox_norm);
      const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id) : undefined;
      const sourceCaption = sourceBoundFormalCaption(block, sourceTextByBlockId);
      const gap = blockBbox ? blockBbox[1] - visualBottom : Number.POSITIVE_INFINITY;
      const horizontalOverlap = blockBbox ? axisOverlap(visualLeft, visualRight, blockBbox[0], blockBbox[2]) : 0;
      return ["text", "title"].includes(String(block.role))
        && hasFormalCaption(block)
        && typeof block.id === "string"
        && Boolean(source)
        && Boolean(blockBbox)
        && gap >= -20
        && gap <= 120
        && horizontalOverlap >= 0.6 * Math.min(visualRight - visualLeft, Number(blockBbox?.[2]) - Number(blockBbox?.[0]))
        && Boolean(sourceCaption);
    });
    if (formal.length !== 1) return undefined;
    const anchor = formal[0];
    const selected = [anchor];
    if (!terminalCaptionSource(anchor, sourceTextByBlockId)) {
      const following = ordered.filter((block) => (
        Number(block.page_order) > Number(anchor.page_order)
        && ["text", "title"].includes(String(block.role))
        && !runningPageHeader(block)
        && typeof block.id === "string"
        && Boolean(sourceTextByBlockId.get(block.id))
      ));
      const continuationCandidates = following.filter((block) => {
        const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id) : undefined;
        return !hasFormalCaption(block)
          && sameTopCaptionBand(anchor, block)
          && sourceStartsLikeCaptionContinuation(source)
          && terminalCaptionSource(block, sourceTextByBlockId);
      });
      const continuation = continuationCandidates.length === 1 && following[0] === continuationCandidates[0]
        ? continuationCandidates[0]
        : undefined;
      if (!continuation) return undefined;
      selected.push(continuation);
    }
    if (requireCaptionOnlyPage) {
      const selectedIds = new Set(selected.map((block) => String(block.id)));
      const unrelated = ordered.filter((block) => (
        ["text", "title"].includes(String(block.role))
        && !runningPageHeader(block)
        && typeof block.id === "string"
        && Boolean(sourceTextByBlockId.get(block.id))
        && !selectedIds.has(block.id)
      ));
      if (unrelated.length) return undefined;
    }
    const ranges = selected.map((block) => markdownRange(
      block,
      sourceTextByBlockId.get(String(block.id)),
      input.articleMarkdown
    ));
    if (ranges.some((range) => !range)) return undefined;
    const exactRanges = ranges.filter((range): range is NonNullable<typeof range> => Boolean(range));
    if (exactRanges.some((range, index) => index > 0 && range.start <= exactRanges[index - 1].end)) return undefined;
    const captionText = selected.map((block) => sourceTextByBlockId.get(String(block.id))!).join(" ").replace(/\s+/g, " ").trim();
    const captionPanels = expandedCaptionPanelLabels(captionText);
    const visualPanels = [...new Set(panelLabels(pageVisuals).map((label) => label.toLowerCase()).filter((label) => /^[a-z]$/.test(label)))];
    if (visualPanels.length && visualPanels.some((label) => !captionPanels.has(label))) return undefined;
    return {
      caption: captionText,
      captionBlocks: selected,
      captionSourceRanges: exactRanges,
      captionStatus: "complete"
    };
  };
  const viewerMarkdownOccurrences = input.articleMarkdown
    ? markdownImageOccurrences(viewer, input.articleMarkdown)
    : new Map<string, MarkdownImageOccurrence>();
  const provenLicenseFooterBadge = (block: UnknownRecord): boolean => {
    if (!input.articleMarkdown || !footerBadgeGeometry(block) || typeof block.id !== "string") return false;
    const pageIndex = pageByBlockId.get(block.id);
    const page = pageRecords.find((candidate) => Number(candidate.page_idx) === pageIndex);
    if (!Array.isArray(page?.blocks)) return false;
    const ordered = page.blocks.map(record)
      .filter((candidate): candidate is UnknownRecord => Boolean(candidate))
      .sort((left, right) => Number(left.page_order) - Number(right.page_order) || Number(left.source_index) - Number(right.source_index));
    const blockIndex = ordered.indexOf(block);
    if (blockIndex < 0) return false;
    const following = ordered.slice(blockIndex + 1).find((candidate) => (
      ["text", "title"].includes(String(candidate.role))
      && typeof candidate.id === "string"
      && Boolean(sourceTextByBlockId.get(candidate.id))
    ));
    if (!following || typeof following.id !== "string" || hasFormalCaption(following)) return false;
    const licenseText = sourceTextByBlockId.get(following.id)!;
    if (
      !/^Open Access\s+This article is licensed under a Creative Commons/i.test(licenseText)
      || !/creativecommons\.org\/licenses\//i.test(licenseText)
    ) return false;
    const blockBbox = normalizedBboxArray(block.bbox_norm);
    const textBbox = normalizedBboxArray(following.bbox_norm);
    if (!blockBbox || !textBbox || textBbox[0] < blockBbox[2] || textBbox[0] - blockBbox[2] > 15) return false;
    const yOverlap = axisOverlap(blockBbox[1], blockBbox[3], textBbox[1], textBbox[3]);
    if (yOverlap < 0.8 * Math.min(blockBbox[3] - blockBbox[1], textBbox[3] - textBbox[1])) return false;
    const ids = strings(block.markdown_image_ids);
    if (ids.length !== 1) return false;
    const imageOccurrence = viewerMarkdownOccurrences.get(ids[0]);
    const textRange = markdownRange(following, licenseText, input.articleMarkdown);
    return Boolean(
      imageOccurrence
      && textRange
      && textRange.start > imageOccurrence.end
      && !input.articleMarkdown.slice(imageOccurrence.end, textRange.start).trim()
    );
  };
  const reportingSignature = (page: UnknownRecord): boolean => Array.isArray(page.blocks) && page.blocks.map(record).some((block) => {
    if (!block || block.role !== "marginalia" || typeof block.id !== "string") return false;
    const blockBbox = normalizedBboxArray(block.bbox_norm);
    const source = sourceTextByBlockId.get(block.id)?.replace(/\s+/g, " ").trim().toLowerCase();
    return source === "nature portfolio | reporting summary"
      && Boolean(blockBbox)
      && Number(blockBbox?.[0]) >= 900
      && Number(blockBbox?.[1]) <= 60
      && Number(blockBbox?.[2]) - Number(blockBbox?.[0]) <= 40;
  });
  const reportingBoundaries = pageRecords.filter((page) => {
    if (!runtimeInferenceSafe || !Array.isArray(page.blocks) || !Number.isInteger(page.page_idx) || !reportingSignature(page)) return false;
    const ordered = page.blocks.map(record)
      .filter((block): block is UnknownRecord => Boolean(block))
      .sort((left, right) => Number(left.page_order) - Number(right.page_order));
    const brand = ordered.filter((block) => {
      const blockBbox = normalizedBboxArray(block.bbox_norm);
      const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id)?.replace(/\s+/g, " ").trim().toLowerCase() : undefined;
      return block.role === "title" && source === "natureportfolio" && Boolean(blockBbox)
        && Number(blockBbox?.[0]) <= 100 && Number(blockBbox?.[1]) <= 120;
    });
    const summary = ordered.filter((block) => {
      const blockBbox = normalizedBboxArray(block.bbox_norm);
      const source = typeof block.id === "string" ? sourceTextByBlockId.get(block.id)?.replace(/\s+/g, " ").trim().toLowerCase() : undefined;
      return block.role === "title" && source === "reporting summary" && Boolean(blockBbox)
        && Number(blockBbox?.[0]) <= 100 && Number(blockBbox?.[1]) >= 100 && Number(blockBbox?.[1]) <= 260;
    });
    return brand.length === 1 && summary.length === 1 && Number(brand[0].page_order) < Number(summary[0].page_order);
  });
  const reportingFormPages = new Set<number>();
  if (reportingBoundaries.length === 1) {
    const start = Number(reportingBoundaries[0].page_idx);
    let expected = start;
    for (const page of [...pageRecords].sort((left, right) => Number(left.page_idx) - Number(right.page_idx))) {
      const pageIndex = Number(page.page_idx);
      if (pageIndex < start) continue;
      if (pageIndex !== expected || !reportingSignature(page)) break;
      reportingFormPages.add(pageIndex);
      expected += 1;
    }
  }
  const provenReportingFormTable = (block: UnknownRecord, visual: MinerUVisual): boolean => {
    const actualPageIndex = typeof block.id === "string" ? pageByBlockId.get(block.id) : undefined;
    if (
      actualPageIndex === undefined
      || actualPageIndex !== visual.pageIndex
      || !reportingFormPages.has(actualPageIndex)
      || visual.placementBlockId
      || block.role !== "table"
      || captionItems(block).length
      || hasFormalCaption(block)
      || strings(block.markdown_image_ids).length
      || typeof block.id !== "string"
    ) return false;
    return !rawGroupRecords.some((group) => strings(group.member_block_ids).includes(block.id as string))
      && !captionLinks.map(record).some((link) => link?.visual_block_id === block.id);
  };
  for (const page of pageRecords) {
    if (!Number.isInteger(page.page_idx) || !Array.isArray(page.blocks)) continue;
    const pageIndex = Number(page.page_idx);
    const pageGroups = rawGroupRecords.filter((group) => Number(group.page_idx) === pageIndex);
    const autoGroups = pageGroups.filter((group) => group.decision === "auto");
    if (
      autoGroups.length < 2
      || pageGroups.length !== autoGroups.length
      || !runtimeInferenceSafe
      || !autoGroups.every((group) => groupSupportsRuntimeInference(group, pageIndex))
      || captionLinks.map(record).some((link) => Number(link?.source_page_idx) === pageIndex)
      || !input.articleMarkdown
      || !input.sourcePdfPath
    ) continue;

    const pageVisualSourceBlocks = page.blocks.map(record).filter((block): block is UnknownRecord => Boolean(
      block && ["visual", "table"].includes(String(block.role))
    ));
    const pageVisualBlocks = pageVisualSourceBlocks.filter((block): block is UnknownRecord => Boolean(
      block
      && typeof block.id === "string"
      && typeof block.asset_path === "string"
      && visualByPath.has(block.asset_path)
    ));
    const coveredMemberIds = autoGroups.flatMap((group) => strings(group.member_block_ids));
    const pageVisualIds = pageVisualBlocks.map((block) => String(block.id));
    const pageVisualPaths = pageVisualBlocks.map((block) => String(block.asset_path));
    const pageMarkdownIds = pageVisualBlocks.flatMap((block) => strings(block.markdown_image_ids));
    const exactPageCoverage = pageVisualBlocks.length === pageVisualSourceBlocks.length
      && pageVisualPaths.length === new Set(pageVisualPaths).size
      && pageMarkdownIds.length === pageVisualBlocks.length
      && pageMarkdownIds.length === new Set(pageMarkdownIds).size
      && coveredMemberIds.length === new Set(coveredMemberIds).size
      && pageVisualIds.length === new Set(pageVisualIds).size
      && pageVisualIds.length === coveredMemberIds.length
      && pageVisualIds.every((id) => coveredMemberIds.includes(id));
    const samePageCaption = exactPageCoverage
      ? pageSourceCaptionDetails(pageVisualIds, pageIndex, true)
      : undefined;
    const samePageBoxes = pageVisualBlocks.map((block) => normalizedBboxArray(block.bbox_norm));
    const samePageLabels = panelLabels(pageVisualBlocks)
      .map((label) => label.toLowerCase())
      .filter((label) => /^[a-z]$/.test(label));
    if (
      samePageCaption
      && samePageBoxes.length >= 4
      && samePageBoxes.every((value) => Boolean(value))
      && new Set(samePageLabels).size >= 3
    ) {
      const boxes = samePageBoxes.filter((value): value is [number, number, number, number] => Boolean(value));
      const union: [number, number, number, number] = [
        Math.min(...boxes.map((value) => value[0])),
        Math.min(...boxes.map((value) => value[1])),
        Math.max(...boxes.map((value) => value[2])),
        Math.max(...boxes.map((value) => value[3]))
      ];
      const unionArea = ((union[2] - union[0]) * (union[3] - union[1])) / 1_000_000;
      if (unionArea >= 0.3 && unionArea <= 0.9) {
        const memberPaths = pageVisualPaths;
        const markdownIds = pageMarkdownIds;
        const confidence = Math.min(...autoGroups.map((group) => Number(group.confidence)).filter(Number.isFinite));
        const padding = Math.max(0, ...autoGroups.map((group) => Number(record(group.replacement)?.padding_norm ?? 0)).filter(Number.isFinite));
        syntheticGroups.push({
          id: `vr-runtime-full-page-${pageIndex.toString().padStart(4, "0")}`,
          page_idx: pageIndex,
          member_block_ids: pageVisualIds,
          member_asset_paths: memberPaths,
          member_markdown_image_ids: markdownIds,
          caption_anchor_block_ids: samePageCaption.captionBlocks.map((block) => String(block.id)),
          decision: "auto",
          confidence: Number.isFinite(confidence) ? confidence : 0.8,
          replacement: { mode: "pdf_crop", bbox_norm: union, padding_norm: Math.min(50, padding) },
          reason_codes: ["runtime_full_page_visual_component", "unique_same_page_formal_caption"],
          fallback: "original_assets"
        });
        consolidatedPages.add(pageIndex);
        fullPageConsolidationCount += 1;
        continue;
      }
    }

    const meaningfulBlocks = page.blocks.map(record).filter((block): block is UnknownRecord => Boolean(
      block && !["discarded", "marginalia"].includes(String(block.role))
    ));
    if (
      meaningfulBlocks.length < 4
      || meaningfulBlocks.some((block) => !["visual", "table"].includes(String(block.role)))
      || meaningfulBlocks.some(hasFormalCaption)
      || meaningfulBlocks.some((block) => record(block.caption)?.next_page_marker === true)
    ) continue;

    const memberIds = meaningfulBlocks.map((block) => typeof block.id === "string" ? block.id : "");
    const memberPaths = meaningfulBlocks.map((block) => typeof block.asset_path === "string" ? block.asset_path : "");
    const markdownIds = meaningfulBlocks.flatMap((block) => strings(block.markdown_image_ids));
    const memberBboxes = meaningfulBlocks.map((block) => normalizedBboxArray(block.bbox_norm));
    if (
      memberIds.some((id) => !id)
      || new Set(memberIds).size !== memberIds.length
      || memberPaths.some((path) => !isSafeRelativePath(path) || !visualByPath.has(path))
      || new Set(memberPaths).size !== memberPaths.length
      || markdownIds.length !== meaningfulBlocks.length
      || new Set(markdownIds).size !== markdownIds.length
      || memberBboxes.some((value) => !value)
    ) continue;

    if (!stringSetEquals(coveredMemberIds, memberIds)) continue;
    const labels = panelLabels(meaningfulBlocks)
      .map((label) => label.toLowerCase())
      .filter((label) => /^[a-z]$/.test(label));
    if (new Set(labels).size < 3) continue;

    const nextPage = pageRecords.find((candidate) => Number(candidate.page_idx) === pageIndex + 1);
    const nextBlocks = Array.isArray(nextPage?.blocks)
      ? nextPage.blocks.map(record).filter((block): block is UnknownRecord => Boolean(block))
      : [];
    const firstMeaningfulOrder = Math.min(...nextBlocks
      .filter((block) => !["discarded", "marginalia"].includes(String(block.role)))
      .map((block) => Number(block.page_order))
      .filter(Number.isFinite));
    const targetCaptions = nextBlocks.filter((block) => {
      const sourceCaption = sourceBoundFormalCaption(block, sourceTextByBlockId);
      return ["text", "title"].includes(String(block.role))
        && Number(block.page_order) === firstMeaningfulOrder
        && sourceCaption?.terminal === true
        && Array.isArray(block.bbox_norm)
        && Number(block.bbox_norm[1]) <= 320
        && typeof block.id === "string";
    });
    if (targetCaptions.length !== 1) continue;
    const targetText = sourceTextByBlockId.get(String(targetCaptions[0].id))!;
    const targetStart = input.articleMarkdown.indexOf(targetText);
    if (targetStart < 0 || input.articleMarkdown.indexOf(targetText, targetStart + targetText.length) >= 0) continue;

    const boxes = memberBboxes.filter((value): value is [number, number, number, number] => Boolean(value));
    const union: [number, number, number, number] = [
      Math.min(...boxes.map((value) => value[0])),
      Math.min(...boxes.map((value) => value[1])),
      Math.max(...boxes.map((value) => value[2])),
      Math.max(...boxes.map((value) => value[3]))
    ];
    const unionArea = ((union[2] - union[0]) * (union[3] - union[1])) / 1_000_000;
    if (unionArea < 0.3 || unionArea > 0.9) continue;

    const confidence = Math.min(...autoGroups.map((group) => Number(group.confidence)).filter(Number.isFinite));
    const padding = Math.max(0, ...autoGroups.map((group) => Number(record(group.replacement)?.padding_norm ?? 0)).filter(Number.isFinite));
    syntheticGroups.push({
      id: `vr-runtime-full-page-${pageIndex.toString().padStart(4, "0")}`,
      page_idx: pageIndex,
      member_block_ids: memberIds,
      member_asset_paths: memberPaths,
      member_markdown_image_ids: markdownIds,
      caption_anchor_block_ids: [],
      decision: "auto",
      confidence: Number.isFinite(confidence) ? confidence : 0.8,
      replacement: { mode: "pdf_crop", bbox_norm: union, padding_norm: Math.min(50, padding) },
      reason_codes: ["runtime_full_page_visual_component", "unique_next_page_formal_caption"],
      fallback: "original_assets"
    });
    consolidatedPages.add(pageIndex);
    fullPageConsolidationCount += 1;
  }
  const groups: unknown[] = [
    ...rawGroupRecords.filter((group) => !consolidatedPages.has(Number(group.page_idx))),
    ...syntheticGroups
  ];
  let reviewCount = 0;
  let hiddenFooterBadgeCount = 0;
  let hiddenReportingFormVisualCount = 0;

  const captionDetails = (memberIds: string[], blocks: UnknownRecord[], pageIndex: number, inferNextPage: boolean) => {
    const memberSet = new Set(memberIds);
    const links = captionLinks.map(record).filter((link): link is UnknownRecord => Boolean(link))
      .filter((link) => typeof link.visual_block_id === "string" && memberSet.has(link.visual_block_id));
    if (links.length === 0 && inferNextPage && runtimeInferenceSafe && input.articleMarkdown) {
      const sourceFigureKeys = [...new Set(blocks.flatMap((block) => {
        const caption = record(block.caption);
        return caption?.next_page_marker === true ? strings(caption.next_page_figure_keys) : [];
      }))];
      const sourcePage = pages.map(record).find((page) => page?.page_idx === pageIndex);
      const nextPage = pages.map(record).find((page) => page?.page_idx === pageIndex + 1);
      const markerFigureKey = sourceFigureKeys.length === 1 ? sourceFigureKeys[0] : undefined;
      const consolidatedInference = sourceFigureKeys.length === 0 && consolidatedPages.has(pageIndex);
      const sourceClaims = markerFigureKey && Array.isArray(sourcePage?.blocks)
        ? sourcePage.blocks.map(record).filter((block): block is UnknownRecord => Boolean(
          block
          && typeof block.id === "string"
          && block.role === "visual"
          && record(block.caption)?.next_page_marker === true
          && strings(record(block.caption)?.next_page_figure_keys).includes(markerFigureKey)
        ))
        : [];
      const sourceApproved = consolidatedInference
        || (sourceClaims.length === 1 && memberSet.has(String(sourceClaims[0].id)));
      if (sourceApproved && Array.isArray(nextPage?.blocks)) {
        const ordered = nextPage.blocks.map(record)
          .filter((block): block is UnknownRecord => Boolean(block))
          .sort((left, right) => Number(left.page_order) - Number(right.page_order) || Number(left.source_index) - Number(right.source_index));
        const candidates = ordered.filter((block) => {
          const sourceCaption = sourceBoundFormalCaption(block, sourceTextByBlockId);
          return ["text", "title"].includes(String(block.role))
            && Boolean(sourceCaption)
            && (!markerFigureKey || sourceCaption?.key === markerFigureKey.toLowerCase())
            && typeof block.id === "string";
        });
        const meaningful = ordered.filter((block) => {
          if (["discarded", "marginalia"].includes(String(block.role)) || runningPageHeader(block)) return false;
          return !["text", "title"].includes(String(block.role))
            || blockCharCount(block) > 0
            || (typeof block.id === "string" && Boolean(sourceTextByBlockId.get(block.id)));
        });
        const anchor = candidates.length === 1 && meaningful[0] === candidates[0] ? candidates[0] : undefined;
        const anchorBbox = anchor ? normalizedBboxArray(anchor.bbox_norm) : undefined;
        const selected = anchor && (!anchorBbox || anchorBbox[1] <= 320) ? [anchor] : [];
        if (anchor && selected.length && !terminalCaptionSource(anchor, sourceTextByBlockId)) {
          const continuation = meaningful[1];
          const summary = record(continuation?.text);
          const continuationSource = typeof continuation?.id === "string"
            ? sourceTextByBlockId.get(continuation.id)
            : undefined;
          if (
            continuation?.role === "text"
            && summary?.leading_figure_key == null
            && sameTopCaptionBand(anchor, continuation)
            && sourceStartsLikeCaptionContinuation(continuationSource)
            && terminalCaptionSource(continuation, sourceTextByBlockId)
          ) selected.push(continuation);
          else selected.length = 0;
        }
        if (selected.length && terminalCaptionSource(selected[selected.length - 1], sourceTextByBlockId)) {
          const ranges = selected.map((block) => markdownRange(block, sourceTextByBlockId.get(String(block.id)), input.articleMarkdown));
          if (ranges.every((range): range is NonNullable<typeof range> => Boolean(range))) {
            const caption = selected.map((block) => sourceTextByBlockId.get(String(block.id))!).join(" ").replace(/\s+/g, " ").trim();
            return {
              caption,
              captionSourceRanges: [
                ...nextPagePlaceholderRanges(blocks, viewer, input.articleMarkdown),
                ...ranges
              ],
              captionPageIndex: pageIndex + 1,
              captionStatus: "complete" as const,
              panelLabels: panelLabels(blocks)
            };
          }
        }
      }
    }
    if (links.length === 0 && input.articleMarkdown) {
      const sourceCaption = pageSourceCaptionDetails(memberIds, pageIndex);
      if (sourceCaption) {
        return {
          caption: sourceCaption.caption,
          captionSourceRanges: sourceCaption.captionSourceRanges,
          captionPageIndex: pageIndex,
          captionStatus: sourceCaption.captionStatus,
          panelLabels: panelLabels(blocks)
        };
      }
      const samePage = samePageCaptionDetails(blocks, viewer, input.articleMarkdown);
      if (samePage) {
        return {
          ...samePage,
          captionPageIndex: pageIndex,
          panelLabels: panelLabels(blocks)
        };
      }
    }
    if (links.length !== 1) return { panelLabels: panelLabels(blocks) };
    const link = links[0];
    const captionIds = strings(link.caption_block_ids);
    const captionBlocks = captionIds.map((id) => blockById.get(id));
    if (
      captionIds.length === 0
      || captionBlocks.some((block) => !block)
      || !Number.isInteger(link.source_page_idx)
      || !Number.isInteger(link.target_page_idx)
      || Number(link.target_page_idx) !== Number(link.source_page_idx) + 1
      || !["complete", "partial"].includes(String(link.status))
      || captionIds.some((id) => pageByBlockId.get(id) !== Number(link.target_page_idx))
    ) return { panelLabels: panelLabels(blocks) };
    const ranges = captionBlocks.map((block, index) => markdownRange(block, sourceTextByBlockId.get(captionIds[index]), input.articleMarkdown));
    if (ranges.some((range) => !range)) return { panelLabels: panelLabels(blocks) };
    const caption = captionIds.map((id) => sourceTextByBlockId.get(id) || blockCaptionText(blockById.get(id)))
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return {
      caption: caption || undefined,
      captionSourceRanges: [
        ...nextPagePlaceholderRanges(blocks, viewer, input.articleMarkdown ?? ""),
        ...ranges.filter((range): range is NonNullable<typeof range> => Boolean(range))
      ],
      captionPageIndex: Number(link.target_page_idx),
      captionStatus: String(link.status) as "complete" | "partial",
      panelLabels: panelLabels(blocks)
    };
  };

  groups.forEach((groupValue) => {
    const group = record(groupValue);
    if (!group) return;
    if (group.decision === "review") reviewCount += 1;
    if (group.decision !== "auto") return;
    const memberIds = strings(group.member_block_ids);
    const blocks = memberIds.map((id) => blockById.get(id)).filter((value): value is UnknownRecord => Boolean(value));
    if (blocks.length !== memberIds.length || blocks.length < 2) return;
    const pageIndex = Number(group.page_idx);
    const expectedPaths = blocks.map((block) => block.asset_path).filter((value): value is string => typeof value === "string");
    const expectedMarkdownIds = blocks.flatMap((block) => strings(block.markdown_image_ids));
    const paths = strings(group.member_asset_paths);
    const suppliedMarkdownIds = strings(group.member_markdown_image_ids);
    const confidence = Number(group.confidence);
    if (
      !Number.isInteger(pageIndex)
      || blocks.some((block) => typeof block.id !== "string" || pageByBlockId.get(block.id) !== pageIndex)
      || !stringSetEquals(paths, expectedPaths)
      || !stringSetEquals(suppliedMarkdownIds, expectedMarkdownIds)
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
    ) return;
    const memberPaths = [...new Set(paths)].filter((path) => isSafeRelativePath(path) && visualByPath.has(path));
    if (memberPaths.length < 1 || memberPaths.some((path) => consumed.has(path))) return;
    const memberVisuals = memberPaths.map((path) => visualByPath.get(path)!);
    const anchor = [...memberVisuals].sort((left, right) => (orderByPath.get(left.path) ?? 0) - (orderByPath.get(right.path) ?? 0))[0];
    const replacement = record(group.replacement);
    let display: RepairedMinerUVisual["display"];
    let displayPath = anchor.path;
    if (replacement?.mode === "pdf_crop" && input.sourcePdfPath) {
      const crop = bbox(replacement.bbox_norm);
      if (!crop) return;
      display = {
        mode: "pdf-crop",
        pdfPath: input.sourcePdfPath,
        bbox: crop,
        padding: Math.max(0, Math.min(0.05, Number(replacement.padding_norm ?? 0) / 1000))
      };
    } else if (replacement?.mode === "existing_asset") {
      const path = typeof replacement.asset_path === "string" && memberPaths.includes(replacement.asset_path)
        ? replacement.asset_path
        : anchor.path;
      display = { mode: "asset" };
      displayPath = path;
    } else if (replacement?.mode === "fragment_set") {
      const fragments = Array.isArray(replacement.fragments)
        ? replacement.fragments.map(record).flatMap((fragment) => {
          const path = typeof fragment?.asset_path === "string" ? fragment.asset_path : "";
          const fragmentBbox = bbox(fragment?.bbox_norm);
          return memberPaths.includes(path) && fragmentBbox ? [{ path, bbox: fragmentBbox }] : [];
        })
        : [];
      if (fragments.length !== memberPaths.length || new Set(fragments.map((fragment) => fragment.path)).size !== memberPaths.length) return;
      display = { mode: "fragment-set", fragments };
    } else {
      return;
    }
    const captionAnchorIds = strings(group.caption_anchor_block_ids);
    const captionBlocks = [...blocks, ...captionAnchorIds.map((id) => blockById.get(id)).filter((value): value is UnknownRecord => Boolean(value))];
    const linkedCaption = captionDetails(memberIds, blocks, Number.isInteger(group.page_idx) ? Number(group.page_idx) : anchor.pageIndex, true);
    const localPanelRanges = input.articleMarkdown
      ? samePagePanelLabelRanges(blocks, viewer, input.articleMarkdown)
      : [];
    const captionSourceRanges = uniqueSourceRanges(
      linkedCaption.captionSourceRanges ?? [],
      input.articleMarkdown ? nextPagePlaceholderRanges(blocks, viewer, input.articleMarkdown) : [],
      localPanelRanges
    );
    const captionText = linkedCaption.caption || bestCaption(captionBlocks, memberVisuals);
    memberPaths.forEach((path) => consumed.add(path));
    repaired.push({
      order: Math.min(...memberPaths.map((path) => orderByPath.get(path) ?? Number.MAX_SAFE_INTEGER)),
      visual: {
        ...anchor,
        path: displayPath,
        id: typeof group.id === "string" ? group.id : `repair-${anchor.id}`,
        kind: "figure",
        label: labelFromCaption(captionText, anchor.label),
        captionText,
        pageIndex,
        memberAssetPaths: memberPaths,
        memberBlockIds: memberIds,
        memberMarkdownImageIds: strings(group.member_markdown_image_ids).length
          ? strings(group.member_markdown_image_ids)
          : [...new Set(blocks.flatMap((block) => strings(block.markdown_image_ids)))],
        captionSourceRanges: captionSourceRanges.length ? captionSourceRanges : undefined,
        captionPageIndex: linkedCaption.captionPageIndex,
        captionStatus: linkedCaption.captionStatus,
        panelLabels: linkedCaption.panelLabels,
        display
      }
    });
  });

  input.visuals.forEach((visual, index) => {
    if (consumed.has(visual.path)) return;
    const matchingBlocks = [...blockById.values()].filter((block) => block.asset_path === visual.path);
    if (matchingBlocks.length !== 1) {
      repaired.push({ order: index, visual });
      return;
    }
    const block = matchingBlocks[0];
    const blockId = typeof block.id === "string" ? block.id : "";
    const blockMarkdownIds = strings(block.markdown_image_ids);
    if (blockId && blockMarkdownIds.length === 1 && provenLicenseFooterBadge(block)) {
      hiddenFooterBadgeCount += 1;
      repaired.push({
        order: index,
        visual: {
          ...visual,
          hidden: true,
          memberAssetPaths: [visual.path],
          memberBlockIds: [blockId],
          memberMarkdownImageIds: blockMarkdownIds,
          display: { mode: "asset" }
        }
      });
      return;
    }
    if (blockId && provenReportingFormTable(block, visual)) {
      hiddenReportingFormVisualCount += 1;
      repaired.push({
        order: index,
        visual: {
          ...visual,
          hidden: true,
          memberAssetPaths: [visual.path],
          memberBlockIds: [blockId],
          display: { mode: "asset" }
        }
      });
      return;
    }
    const linkedCaption = captionDetails(blockId ? [blockId] : [], [block], visual.pageIndex, true);
    const localPanelRanges = input.articleMarkdown
      ? samePagePanelLabelRanges([block], viewer, input.articleMarkdown)
      : [];
    const captionSourceRanges = uniqueSourceRanges(
      linkedCaption.captionSourceRanges ?? [],
      input.articleMarkdown ? nextPagePlaceholderRanges([block], viewer, input.articleMarkdown) : [],
      localPanelRanges
    );
    const captionText = linkedCaption.caption || bestCaption([block], [visual]) || visual.captionText;
    repaired.push({
      order: index,
      visual: {
        ...visual,
        captionText,
        label: labelFromCaption(captionText, visual.label),
        memberAssetPaths: [visual.path],
        memberBlockIds: blockId ? [blockId] : undefined,
        memberMarkdownImageIds: blockMarkdownIds,
        captionSourceRanges: captionSourceRanges.length ? captionSourceRanges : undefined,
        captionPageIndex: linkedCaption.captionPageIndex,
        captionStatus: linkedCaption.captionStatus,
        panelLabels: linkedCaption.panelLabels,
        display: { mode: "asset" }
      }
    });
  });
  repaired.sort((left, right) => left.order - right.order);
  const repairedCount = repaired.filter((item) => item.visual.display?.mode === "pdf-crop").length;
  diagnostics.push({
    level: "info",
    code: "mineru-visual-repair-applied",
    message: `已应用 ${repairedCount} 个高置信度视觉修复组，合并 ${consumed.size} 个 MinerU 碎图片段。`
  });
  if (fullPageConsolidationCount) {
    diagnostics.push({
      level: "info",
      code: "mineru-full-page-visual-consolidated",
      message: `已将 ${fullPageConsolidationCount} 个具有唯一正式图注的整页多面板视觉区域合并为单一显示对象。`
    });
  }
  if (reviewCount) {
    diagnostics.push({
      level: "warning",
      code: "mineru-visual-repair-review",
      message: `${reviewCount} 个不确定视觉组合未自动合并，继续显示原始图片。`
    });
  }
  if (hiddenFooterBadgeCount) {
    diagnostics.push({
      level: "info",
      code: "mineru-footer-badge-suppressed",
      message: `已从图表导航隐藏 ${hiddenFooterBadgeCount} 个与许可声明严格关联的页脚徽标；正文、源图片和 Markdown 未修改。`
    });
  }
  if (hiddenReportingFormVisualCount) {
    diagnostics.push({
      level: "info",
      code: "mineru-reporting-form-visuals-suppressed",
      message: `已从图表导航隐藏 ${hiddenReportingFormVisualCount} 个可验证的出版商 reporting form 表格；正文和源文件未修改。`
    });
  }
  return { visuals: repaired.map((item) => item.visual), diagnostics };
}
