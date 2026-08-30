import { sha256Utf8 } from "../../after-mineru-contract/src/index";

type UnknownRecord = Record<string, unknown>;

const COORDINATE_EXTENT = 1000;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
const FIGURE_KEY_RE = /^\s*(extended\s+data\s+fig(?:ure)?|supplementary\s+fig(?:ure)?|supporting(?:\s+information)?\s+fig(?:ure)?|fig(?:ure)?|图)\.?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i;
const FIGURE_REFERENCE_VERBS_RE = /^(?:shows?|illustrates?|depicts?|demonstrates?|presents?|reports?|displays?|compares?|lists?|summari[sz]es?|gives?|provides?|plots?|is|are|was|were)\b/i;
const NEXT_PAGE_CAPTION_SOURCE = "(?:see\\s+(?:the\\s+)?next\\s+page\\s+for\\s+(?:the\\s+)?caption|caption\\s+(?:is\\s+)?continued\\s+on\\s+(?:the\\s+)?next\\s+page|continued\\s+on\\s+(?:the\\s+)?next\\s+page|caption\\s+(?:is\\s+)?(?:on|over)\\s+(?:the\\s+)?next\\s+page|continued\\s+overleaf|图注(?:见|续见|续|在)?(?:下一|下)页|(?:下一|下)页(?:续见|续|见)图注)";
const NEXT_PAGE_PLACEHOLDER_SPAN_RE = new RegExp(
  `(^|[^A-Za-z0-9_])((?:extended\\s+data\\s+fig(?:ure)?|supplementary\\s+fig(?:ure)?|supporting(?:\\s+information)?\\s+fig(?:ure)?|fig(?:ure)?|图)\\.?\\s*[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\\s*[|｜:：.]\\s*${NEXT_PAGE_CAPTION_SOURCE}(?:[.!?。！？](?=\\s|$)|(?=$)))`,
  "gi"
);
const NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_])(?:extended\\s+data\\s+fig(?:ure)?|supplementary\\s+fig(?:ure)?|supporting(?:\\s+information)?\\s+fig(?:ure)?|fig(?:ure)?|图)\\.?\\s*[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\\s*[|｜:：.]\\s*${NEXT_PAGE_CAPTION_SOURCE}`,
  "i"
);
const PANEL_LABEL_RE = /^\s*[\[(]?[A-Za-z][\])\].:]?\s*$/;
const PANEL_CONTINUATION_RE = /^\s*[\[(]?[A-Za-z][\])\].:]?(?=\s|[,;:])/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const VISUAL_SOURCE_TYPES = new Set(["image", "chart"]);
const TABLE_SOURCE_TYPES = new Set(["table", "table_body"]);
const EQUATION_SOURCE_TYPES = new Set(["equation", "interline_equation"]);
const MARGINAL_SOURCE_TYPES = new Set([
  "aside_text", "footer", "header", "page_footer", "page_footnote", "page_header", "page_number"
]);
const CAPTION_FIELDS = ["image_caption", "chart_caption", "table_caption"] as const;
const FOOTNOTE_FIELDS = ["image_footnote", "chart_footnote", "table_footnote"] as const;
const MAX_SOURCE_ELEMENTS = 8192;
const MAX_VIEWER_PAGES = 2048;
const MAX_BLOCKS_PER_PAGE = 512;
const MAX_MARKDOWN_IMAGES = 4096;
const MAX_VISUAL_CANDIDATES = 128;
const MAX_TEXT_NESTING_DEPTH = 64;
const MAX_TEXT_NODES_PER_VALUE = 65_536;
const MAX_TEXT_STRINGS_PER_VALUE = MAX_SOURCE_ELEMENTS;
const MAX_CANDIDATE_INPUT_ITEMS = MAX_SOURCE_ELEMENTS;
const MAX_CANDIDATE_KEYS_PER_BLOCK = MAX_VISUAL_CANDIDATES;
const MAX_CANDIDATE_IDS_PER_FIELD = MAX_BLOCKS_PER_PAGE;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function sha256(value: string): string {
  return sha256Utf8(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(6));
}

export function normalizeMineruContractBbox(raw: unknown, scaleUnitInterval = false): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  if (raw.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > COORDINATE_EXTENT)) {
    return null;
  }
  let coordinates = [...raw] as number[];
  if (scaleUnitInterval && Math.max(...coordinates.map(Math.abs)) <= 1.5) {
    coordinates = coordinates.map((value) => value * COORDINATE_EXTENT);
  }
  const [x0, y0, x1, y1] = coordinates;
  return x1 > x0 && y1 > y0 ? coordinates.map(stableNumber) : null;
}

function ownValues(value: UnknownRecord): IterableIterator<unknown> {
  return (function* values() {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) yield value[key];
    }
  })();
}

function flattenStrings(value: unknown): string[] {
  const strings: string[] = [];
  const stack: Array<{ iterator: Iterator<unknown>; depth: number }> = [{ iterator: [value].values(), depth: 0 }];
  let visitedNodes = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame.iterator.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    visitedNodes += 1;
    if (visitedNodes > MAX_TEXT_NODES_PER_VALUE) throw new Error("MinerU text exceeds the viewer-contract value limit");
    const item = next.value;
    if (typeof item === "string") {
      const normalized = item.trim();
      if (normalized) {
        if (strings.length >= MAX_TEXT_STRINGS_PER_VALUE) throw new Error("MinerU text exceeds the viewer-contract string limit");
        strings.push(normalized);
      }
      continue;
    }
    const object = record(item);
    if (!Array.isArray(item) && !object) continue;
    if (frame.depth >= MAX_TEXT_NESTING_DEPTH) throw new Error("MinerU text exceeds the viewer-contract nesting limit");
    stack.push({ iterator: Array.isArray(item) ? item.values() : ownValues(object!), depth: frame.depth + 1 });
  }
  return strings;
}

function stringSummary(strings: Iterable<string>): UnknownRecord {
  const values = [...strings].filter(Boolean);
  return {
    item_count: values.length,
    char_count: values.reduce((sum, value) => sum + [...value].length, 0),
    sha256: values.length ? sha256(values.join("\n")) : null
  };
}

function normalizeFigureKey(value: string): string | null {
  const match = FIGURE_KEY_RE.exec(value);
  if (!match) return null;
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

function formalFigureCaptionKey(value: string): string | null {
  const match = FIGURE_KEY_RE.exec(value);
  if (!match) return null;
  const remainder = value.slice(match[0].length);
  const delimited = /^\s*[|｜:：.]\s*([^|｜:：.\s][\s\S]*)$/.exec(remainder);
  const undelimited = /^\s+([^|｜:：.\s][\s\S]*)$/.exec(remainder);
  const title = (delimited?.[1] ?? undelimited?.[1] ?? "").trim();
  return title.length >= 5 && !FIGURE_REFERENCE_VERBS_RE.test(title) ? normalizeFigureKey(value) : null;
}

function nextPageCaptionPlaceholderKey(value: string): string | null {
  const match = FIGURE_KEY_RE.exec(value);
  if (!match) return null;
  const remainder = value.slice(match[0].length).trimStart();
  if (!remainder || !"|｜:：.".includes(remainder[0])) return null;
  const marker = remainder.slice(1).trim();
  if (!marker || !(new RegExp(`^(?:${NEXT_PAGE_CAPTION_SOURCE})[.!?。！？]?$`, "i")).test(marker)) return null;
  return normalizeFigureKey(value);
}

function nextPagePlaceholderSpans(value: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  NEXT_PAGE_PLACEHOLDER_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEXT_PAGE_PLACEHOLDER_SPAN_RE.exec(value))) {
    const placeholder = match[2].trim();
    const figureKey = nextPageCaptionPlaceholderKey(placeholder);
    if (figureKey) result.push([placeholder, figureKey]);
  }
  return result;
}

function nextPagePlaceholders(strings: Iterable<string>): UnknownRecord[] {
  return [...strings].flatMap((value, index) => {
    const spans = nextPagePlaceholderSpans(value);
    return spans.length === 1 ? [{ index, text: spans[0][0], figure_key: spans[0][1] }] : [];
  });
}

function endsWithTerminalPunctuation(value: string): boolean {
  let normalized = value.trim();
  while (/<\/[^>]+>\s*$/.test(normalized)) normalized = normalized.replace(/<\/[^>]+>\s*$/, "").trimEnd();
  return /[.!?。！？]["'”’\)\]}]*$/.test(normalized);
}

function firstAlphaIsLowercase(value: string): boolean {
  for (const character of value) {
    if (!/\p{L}/u.test(character)) continue;
    return character === character.toLowerCase() && character !== character.toUpperCase();
  }
  return false;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function contentDetectionSummary(strings: Iterable<string>): UnknownRecord {
  const values = [...strings].filter(Boolean);
  const placeholders = nextPagePlaceholders(values);
  const placeholderKeys = placeholders.map((value) => String(value.figure_key));
  const figureKeys = unique([
    ...values.map(normalizeFigureKey).filter((value): value is string => Boolean(value)),
    ...placeholderKeys
  ]);
  const formalKeys = unique(values.map(formalFigureCaptionKey).filter((value): value is string => Boolean(value)));
  const firstValue = values[0] ?? "";
  return {
    figure_keys: figureKeys,
    leading_figure_key: normalizeFigureKey(firstValue),
    formal_figure_caption_keys: formalKeys,
    leading_formal_figure_caption_key: formalFigureCaptionKey(firstValue),
    next_page_marker: placeholders.length > 0,
    next_page_figure_keys: unique(placeholderKeys),
    next_page_placeholders: placeholders,
    starts_with_lowercase: firstAlphaIsLowercase(firstValue),
    starts_with_panel_label: PANEL_CONTINUATION_RE.test(firstValue),
    ends_with_terminal_punctuation: endsWithTerminalPunctuation(firstValue)
  };
}

function captionItemKind(value: string): [string, string | null] {
  const figureKey = normalizeFigureKey(value);
  const placeholderKey = nextPageCaptionPlaceholderKey(value);
  if (placeholderKey) return ["next-page-placeholder", placeholderKey];
  if (nextPagePlaceholderSpans(value).length || NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE.test(value)) return ["other", figureKey];
  if (formalFigureCaptionKey(value)) return ["formal-caption", figureKey];
  if (PANEL_LABEL_RE.test(value)) return ["panel-label", null];
  if (
    [...value].length >= 24 && !figureKey && endsWithTerminalPunctuation(value)
    && (PANEL_CONTINUATION_RE.test(value) || firstAlphaIsLowercase(value))
  ) return ["caption-continuation", null];
  return ["other", figureKey];
}

function captionItems(strings: Iterable<string>): UnknownRecord[] {
  return [...strings].map((value, index) => {
    const [kind, figureKey] = captionItemKind(value);
    return figureKey ? { index, text: value, kind, figure_key: figureKey } : { index, text: value, kind };
  });
}

function summarizeCaption(item: UnknownRecord): UnknownRecord {
  const strings: string[] = [];
  const fields: string[] = [];
  const content = record(item.content) ?? {};
  for (const field of CAPTION_FIELDS) {
    for (const container of [item, content]) {
      if (!(field in container)) continue;
      fields.push(field);
      strings.push(...flattenStrings(container[field]));
    }
  }
  return {
    ...stringSummary(strings),
    fields,
    items: captionItems(strings),
    long_item_count: strings.filter((value) => [...value].length >= 30).length,
    figure_anchor_count: strings.filter((value) => formalFigureCaptionKey(value)).length,
    panel_label_count: strings.filter((value) => PANEL_LABEL_RE.test(value)).length,
    ...contentDetectionSummary(strings)
  };
}

function summarizeFootnotes(item: UnknownRecord): UnknownRecord {
  const strings: string[] = [];
  const fields: string[] = [];
  const content = record(item.content) ?? {};
  for (const field of FOOTNOTE_FIELDS) {
    for (const container of [item, content]) {
      if (!(field in container)) continue;
      fields.push(field);
      strings.push(...flattenStrings(container[field]));
    }
  }
  return { ...stringSummary(strings), fields };
}

function classifyElement(item: UnknownRecord): string {
  const sourceType = String(item.type ?? "unknown").trim().toLowerCase();
  if (VISUAL_SOURCE_TYPES.has(sourceType)) return "visual";
  if (TABLE_SOURCE_TYPES.has(sourceType)) return "table";
  if (EQUATION_SOURCE_TYPES.has(sourceType)) return "equation";
  if (MARGINAL_SOURCE_TYPES.has(sourceType)) return "marginalia";
  if (["title", "paragraph_title"].includes(sourceType)) return "title";
  if (sourceType === "text" && item.text_level !== null && item.text_level !== undefined) return "title";
  if (["text", "paragraph", "ref_text", "list"].includes(sourceType)) return "text";
  return "other";
}

function normalizeAssetPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value: string;
  try {
    value = decodeURIComponent(raw.trim().replace(/^<|>$/g, "")).replace(/\\/g, "/");
  } catch {
    return null;
  }
  while (value.startsWith("./")) value = value.slice(2);
  if (!value || value.includes("\0") || value.startsWith("/") || URL_SCHEME_RE.test(value) || value.split("/").includes("..")) return null;
  return value;
}

function extractAssetPath(item: UnknownRecord): string | null {
  const content = record(item.content) ?? {};
  const source = record(content.image_source) ?? record(content.table_source) ?? {};
  for (const value of [item.img_path, item.image_path, source.path, source.src, content.img_path]) {
    const path = normalizeAssetPath(value);
    if (path) return path;
  }
  return null;
}

function flattenSourceElements(payload: unknown): { items: Array<[unknown, number | null]>; nestedByPage: boolean } {
  if (!Array.isArray(payload)) return { items: [], nestedByPage: false };
  const nestedByPage = payload.length > 0 && payload.every(Array.isArray);
  if (!nestedByPage) {
    if (payload.length > MAX_SOURCE_ELEMENTS) throw new Error("MinerU result exceeds the viewer-contract element limit");
    return { items: payload.map((item): [unknown, null] => [item, null]), nestedByPage };
  }
  if (payload.length > MAX_VIEWER_PAGES) throw new Error("MinerU result exceeds the viewer-contract page limit");
  const items: Array<[unknown, number]> = [];
  for (let pageIndex = 0; pageIndex < payload.length; pageIndex += 1) {
    const page = payload[pageIndex] as unknown[];
    for (const item of page) {
      if (items.length >= MAX_SOURCE_ELEMENTS) throw new Error("MinerU result exceeds the viewer-contract element limit");
      items.push([item, pageIndex]);
    }
  }
  return { items, nestedByPage };
}

export interface MarkdownImageOccurrence extends UnknownRecord {
  id: string;
  order: number;
  asset_path: string;
  occurrence: number;
  syntax: "markdown" | "html";
  char_start: number;
  char_end: number;
}

export function extractMarkdownImageOccurrences(markdown: string): MarkdownImageOccurrence[] {
  const raw: Array<{ start: number; end: number; path: string; syntax: "markdown" | "html" }> = [];
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_RE.exec(markdown))) {
    const path = normalizeAssetPath(match[1] || match[2]);
    if (path) {
      if (raw.length >= MAX_MARKDOWN_IMAGES) throw new Error("Markdown exceeds the viewer-contract image limit");
      raw.push({ start: match.index, end: match.index + match[0].length, path, syntax: "markdown" });
    }
  }
  HTML_IMAGE_RE.lastIndex = 0;
  while ((match = HTML_IMAGE_RE.exec(markdown))) {
    const path = normalizeAssetPath(match[1]);
    if (path) {
      if (raw.length >= MAX_MARKDOWN_IMAGES) throw new Error("Markdown exceeds the viewer-contract image limit");
      raw.push({ start: match.index, end: match.index + match[0].length, path, syntax: "html" });
    }
  }
  raw.sort((left, right) => left.start - right.start || left.end - right.end);
  const occurrences = new Map<string, number>();
  return raw.map((value, order) => {
    const occurrence = occurrences.get(value.path) ?? 0;
    occurrences.set(value.path, occurrence + 1);
    return {
      id: `md-img-${String(order).padStart(4, "0")}`,
      order,
      asset_path: value.path,
      occurrence,
      syntax: value.syntax,
      char_start: value.start,
      char_end: value.end
    };
  });
}

function textSummary(item: UnknownRecord): UnknownRecord {
  const strings = ["text", "content", "list_items"].flatMap((field) => field in item ? flattenStrings(item[field]) : []);
  return { ...stringSummary(strings), ...contentDetectionSummary(strings) };
}

function metadata(item: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = {};
  for (const field of ["text_level", "text_format", "sub_type"] as const) {
    const value = item[field];
    if (["string", "number", "boolean"].includes(typeof value)) result[field] = value;
  }
  return result;
}

export function buildMineruViewerIndex(
  payload: unknown,
  markdownImages: MarkdownImageOccurrence[],
  inputHashes: { article: string; mineru_result: string },
  options: { packagedSourcePdf: boolean; sourceAvailableAtGeneration?: boolean }
): UnknownRecord {
  const issues: UnknownRecord[] = [];
  const { items: sourceElements, nestedByPage } = flattenSourceElements(payload);
  if (sourceElements.length > MAX_SOURCE_ELEMENTS) throw new Error("MinerU result exceeds the viewer-contract element limit");
  if (markdownImages.length > MAX_MARKDOWN_IMAGES) throw new Error("Markdown exceeds the viewer-contract image limit");
  if (!Array.isArray(payload)) issues.push({ code: "mineru_result_not_array" });
  const markdownByPath = new Map<string, string[]>();
  for (const image of markdownImages) {
    const path = normalizeAssetPath(image.asset_path);
    if (path && typeof image.id === "string") markdownByPath.set(path, [...(markdownByPath.get(path) ?? []), image.id]);
  }
  const markdownCursor = new Map<string, number>();
  const pages = new Map<number, UnknownRecord[]>();
  let locatedBlockCount = 0;
  let acceptedBlockCount = 0;
  sourceElements.forEach(([rawItem, nestedPageIndex], sourceIndex) => {
    const item = record(rawItem);
    if (!item) {
      issues.push({ code: "element_not_object", source_index: sourceIndex });
      return;
    }
    const rawPageIndex = nestedByPage ? nestedPageIndex : item.page_idx;
    if (!Number.isInteger(rawPageIndex) || Number(rawPageIndex) < 0) {
      issues.push({ code: "invalid_page_idx", source_index: sourceIndex });
      return;
    }
    const pageIndex = Number(rawPageIndex);
    acceptedBlockCount += 1;
    const bbox = normalizeMineruContractBbox(item.bbox, nestedByPage);
    if (!bbox) issues.push({ code: "missing_or_invalid_bbox", source_index: sourceIndex });
    else locatedBlockCount += 1;
    const assetPath = extractAssetPath(item);
    const markdownIds: string[] = [];
    if (assetPath) {
      const cursor = markdownCursor.get(assetPath) ?? 0;
      const candidates = markdownByPath.get(assetPath) ?? [];
      if (cursor < candidates.length) {
        markdownIds.push(candidates[cursor]);
        markdownCursor.set(assetPath, cursor + 1);
      }
    }
    const page = pages.get(pageIndex) ?? [];
    if (page.length >= MAX_BLOCKS_PER_PAGE) throw new Error("MinerU page exceeds the viewer-contract block limit");
    page.push({
      id: `p${String(pageIndex).padStart(4, "0")}-s${String(sourceIndex).padStart(6, "0")}`,
      source_index: sourceIndex,
      page_order: page.length,
      source_type: String(item.type ?? "unknown"),
      role: classifyElement(item),
      bbox_norm: bbox,
      asset_path: assetPath,
      markdown_image_ids: markdownIds,
      text: textSummary(item),
      caption: summarizeCaption(item),
      footnote: summarizeFootnotes(item),
      metadata: metadata(item)
    });
    pages.set(pageIndex, page);
  });
  const pageRecords = [...pages.entries()].sort(([left], [right]) => left - right)
    .map(([pageIndex, blocks]) => ({ page_idx: pageIndex, blocks }));
  if (pageRecords.length > MAX_VIEWER_PAGES) throw new Error("MinerU result exceeds the viewer-contract page limit");
  return {
    schema_version: 1,
    status: locatedBlockCount === 0 ? "unavailable" : issues.length ? "partial" : "complete",
    inputs: {
      article: { path: "article.md", sha256: inputHashes.article },
      mineru_result: { path: "mineru-result.json", sha256: inputHashes.mineru_result }
    },
    coordinate_system: { kind: "normalized-page", extent: COORDINATE_EXTENT, page_index_base: 0 },
    pdf_source: {
      packaged_path: options.packagedSourcePdf ? "_extraction/source.pdf" : null,
      manifest_source_fallback: true,
      available_at_generation: options.sourceAvailableAtGeneration ?? true
    },
    summary: {
      source_element_count: sourceElements.length,
      accepted_block_count: acceptedBlockCount,
      located_block_count: locatedBlockCount,
      page_count: pageRecords.length,
      markdown_image_count: markdownImages.length
    },
    markdown_images: markdownImages,
    pages: pageRecords,
    issues
  };
}

function contractBbox(value: unknown): number[] | null {
  return normalizeMineruContractBbox(value);
}

function bboxArea(bbox: number[]): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

function intersectionArea(left: number[], right: number[]): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  return width * height;
}

function visualBlocks(pageBlocks: UnknownRecord[]): UnknownRecord[] {
  return pageBlocks.filter((block) => block.role === "visual" && block.asset_path && contractBbox(block.bbox_norm));
}

function findEnclosingVisuals(
  pageBlocks: UnknownRecord[],
  containmentThreshold = 0.95,
  areaRatio = 1.2
): UnknownRecord[] {
  const visuals = visualBlocks(pageBlocks);
  const relations: UnknownRecord[] = [];
  for (const child of visuals) {
    const childBbox = contractBbox(child.bbox_norm)!;
    const childArea = bboxArea(childBbox);
    const candidates: Array<{ area: number; parent: UnknownRecord; containment: number }> = [];
    for (const parent of visuals) {
      if (parent.id === child.id) continue;
      const parentBbox = contractBbox(parent.bbox_norm)!;
      const parentArea = bboxArea(parentBbox);
      if (parentArea < childArea * areaRatio) continue;
      const containment = intersectionArea(childBbox, parentBbox) / childArea;
      if (containment >= containmentThreshold) candidates.push({ area: parentArea, parent, containment });
    }
    candidates.sort((left, right) => left.area - right.area);
    const match = candidates[0];
    if (match) relations.push({ child_id: child.id, parent_id: match.parent.id, containment: Number(match.containment.toFixed(4)) });
  }
  return relations;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function repairGroupFigureKeys(memberIds: string[], blockById: Map<string, UnknownRecord>): Set<string> {
  const keys = new Set<string>();
  for (const blockId of memberIds) {
    const caption = record(blockById.get(blockId)?.caption);
    if (!caption) continue;
    for (const field of ["formal_figure_caption_keys", "next_page_figure_keys"] as const) {
      stringList(caption[field]).filter(Boolean).forEach((value) => keys.add(value));
    }
  }
  return keys;
}

function repairGroupsAreSourceAdjacent(leftIds: string[], rightIds: string[], blockById: Map<string, UnknownRecord>): boolean {
  const leftOrders = leftIds.map((id) => numberValue(blockById.get(id)?.page_order, Number.NaN));
  const rightOrders = rightIds.map((id) => numberValue(blockById.get(id)?.page_order, Number.NaN));
  if (!leftOrders.length || !rightOrders.length || [...leftOrders, ...rightOrders].some((value) => !Number.isFinite(value))) return false;
  return Math.min(...rightOrders) <= Math.max(...leftOrders) + 1 && Math.min(...leftOrders) <= Math.max(...rightOrders) + 1;
}

function mergeNestedVisualRepairGroups(groups: UnknownRecord[], viewerIndex: UnknownRecord): UnknownRecord[] {
  const blockById = new Map<string, UnknownRecord>();
  for (const pageValue of Array.isArray(viewerIndex.pages) ? viewerIndex.pages : []) {
    const page = record(pageValue);
    for (const blockValue of Array.isArray(page?.blocks) ? page.blocks : []) {
      const block = record(blockValue);
      if (block && typeof block.id === "string") blockById.set(block.id, block);
    }
  }
  const markdownOrder = new Map<string, number>();
  for (const imageValue of Array.isArray(viewerIndex.markdown_images) ? viewerIndex.markdown_images : []) {
    const image = record(imageValue);
    if (image && typeof image.id === "string") markdownOrder.set(image.id, numberValue(image.order));
  }
  const working: UnknownRecord[] = groups.map((group): UnknownRecord => ({
    ...group,
    member_block_ids: [...stringList(group.member_block_ids)],
    member_asset_paths: [...stringList(group.member_asset_paths)],
    member_markdown_image_ids: [...stringList(group.member_markdown_image_ids)],
    caption_anchor_block_ids: [...stringList(group.caption_anchor_block_ids)],
    signals: { ...(record(group.signals) ?? {}) },
    reason_codes: [...stringList(group.reason_codes)],
    warning_codes: [...stringList(group.warning_codes)]
  }));
  while (true) {
    let match: { outerIndex: number; innerIndex: number; containment: number } | undefined;
    for (let leftIndex = 0; leftIndex < working.length && !match; leftIndex += 1) {
      const left = working[leftIndex];
      const leftReplacement = record(left.replacement) ?? {};
      const leftBbox = contractBbox(leftReplacement.bbox_norm);
      if (left.decision !== "auto" || leftReplacement.mode !== "pdf_crop" || !leftBbox) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < working.length; rightIndex += 1) {
        const right = working[rightIndex];
        const rightReplacement = record(right.replacement) ?? {};
        const rightBbox = contractBbox(rightReplacement.bbox_norm);
        if (right.page_idx !== left.page_idx || right.decision !== "auto" || rightReplacement.mode !== "pdf_crop" || !rightBbox) continue;
        const leftArea = bboxArea(leftBbox);
        const rightArea = bboxArea(rightBbox);
        if (leftArea <= 0 || rightArea <= 0) continue;
        const outerIndex = leftArea >= rightArea ? leftIndex : rightIndex;
        const innerIndex = leftArea >= rightArea ? rightIndex : leftIndex;
        const outerBbox = contractBbox(record(working[outerIndex].replacement)?.bbox_norm)!;
        const innerBbox = contractBbox(record(working[innerIndex].replacement)?.bbox_norm)!;
        const outerArea = bboxArea(outerBbox);
        const innerArea = bboxArea(innerBbox);
        if (outerArea < innerArea * 1.35) continue;
        const containment = intersectionArea(outerBbox, innerBbox) / innerArea;
        if (containment < 0.97) continue;
        const outerIds = stringList(working[outerIndex].member_block_ids);
        const innerIds = stringList(working[innerIndex].member_block_ids);
        if (!repairGroupsAreSourceAdjacent(outerIds, innerIds, blockById)) continue;
        const figureKeys = new Set([...repairGroupFigureKeys(outerIds, blockById), ...repairGroupFigureKeys(innerIds, blockById)]);
        if (figureKeys.size !== 1) continue;
        match = { outerIndex, innerIndex, containment };
        break;
      }
    }
    if (!match) break;
    const outer = working[match.outerIndex];
    const inner = working[match.innerIndex];
    const memberIds = unique([...stringList(outer.member_block_ids), ...stringList(inner.member_block_ids)])
      .sort((left, right) => numberValue(blockById.get(left)?.page_order, 1e9) - numberValue(blockById.get(right)?.page_order, 1e9));
    const markdownIds = unique([...stringList(outer.member_markdown_image_ids), ...stringList(inner.member_markdown_image_ids)])
      .sort((left, right) => numberValue(markdownOrder.get(left), 1e9) - numberValue(markdownOrder.get(right), 1e9));
    const captionAnchorIds = unique([...stringList(outer.caption_anchor_block_ids), ...stringList(inner.caption_anchor_block_ids)])
      .sort((left, right) => numberValue(blockById.get(left)?.page_order, 1e9) - numberValue(blockById.get(right)?.page_order, 1e9));
    const signals: UnknownRecord = { ...(record(outer.signals) ?? {}) };
    const innerSignals = record(inner.signals) ?? {};
    for (const name of ["representative_count", "adjacent_pair_count", "caption_char_count", "long_caption_anchor_count", "figure_caption_anchor_count", "panel_label_count"]) {
      signals[name] = numberValue(signals[name]) + numberValue(innerSignals[name]);
    }
    signals.member_count = memberIds.length;
    signals.nested_group_count = numberValue(signals.nested_group_count) + numberValue(innerSignals.nested_group_count) + 1;
    signals.nested_overlap_containment = Number(match.containment.toFixed(4));
    const merged: UnknownRecord = {
      ...outer,
      member_block_ids: memberIds,
      member_asset_paths: [...new Set(memberIds.flatMap((id) => {
        const path = blockById.get(id)?.asset_path;
        return typeof path === "string" && path ? [path] : [];
      }))].sort(),
      member_markdown_image_ids: markdownIds,
      caption_anchor_block_ids: captionAnchorIds,
      confidence: Math.min(numberValue(outer.confidence), numberValue(inner.confidence)),
      signals,
      reason_codes: unique([...stringList(outer.reason_codes), ...stringList(inner.reason_codes), "nested_visual_overlap_deduplicated"]),
      warning_codes: unique([...stringList(outer.warning_codes), ...stringList(inner.warning_codes)])
    };
    const insertAt = Math.min(match.outerIndex, match.innerIndex);
    working.splice(Math.max(match.outerIndex, match.innerIndex), 1);
    working[insertAt] = merged;
  }
  return working;
}

function axisOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function buildVisualAdjacency(pageBlocks: UnknownRecord[], gapThreshold = 20, overlapRatio = 0.15): UnknownRecord[] {
  const visuals = visualBlocks(pageBlocks);
  const edges: UnknownRecord[] = [];
  visuals.forEach((left, index) => {
    const [lx0, ly0, lx1, ly1] = contractBbox(left.bbox_norm)!;
    const leftWidth = lx1 - lx0;
    const leftHeight = ly1 - ly0;
    for (const right of visuals.slice(index + 1)) {
      const [rx0, ry0, rx1, ry1] = contractBbox(right.bbox_norm)!;
      const rightWidth = rx1 - rx0;
      const rightHeight = ry1 - ry0;
      const xGap = Math.max(0, Math.max(lx0, rx0) - Math.min(lx1, rx1));
      const yGap = Math.max(0, Math.max(ly0, ry0) - Math.min(ly1, ry1));
      const xOverlap = axisOverlap(lx0, lx1, rx0, rx1);
      const yOverlap = axisOverlap(ly0, ly1, ry0, ry1);
      if (
        (xGap <= gapThreshold && yOverlap >= overlapRatio * Math.min(leftHeight, rightHeight))
        || (yGap <= gapThreshold && xOverlap >= overlapRatio * Math.min(leftWidth, rightWidth))
      ) edges.push({ left_id: left.id, right_id: right.id, x_gap: stableNumber(xGap), y_gap: stableNumber(yGap) });
    }
  });
  return edges;
}

function clusterVisualBlocks(pageBlocks: UnknownRecord[], gapThreshold = 20, overlapRatio = 0.15): UnknownRecord[][] {
  const visuals = visualBlocks(pageBlocks);
  const byId = new Map(visuals.map((block) => [String(block.id), block]));
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set<string>()]));
  for (const edge of buildVisualAdjacency(visuals, gapThreshold, overlapRatio)) {
    const left = String(edge.left_id);
    const right = String(edge.right_id);
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }
  const components: UnknownRecord[][] = [];
  const visited = new Set<string>();
  for (const block of [...visuals].sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order))) {
    const blockId = String(block.id);
    if (visited.has(blockId)) continue;
    const stack = [blockId];
    visited.add(blockId);
    const componentIds: string[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      componentIds.push(current);
      const neighbors = [...(adjacency.get(current) ?? [])].sort().reverse();
      for (const neighbor of neighbors) if (!visited.has(neighbor)) { visited.add(neighbor); stack.push(neighbor); }
    }
    components.push(componentIds.map((id) => byId.get(id)!).sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order)));
  }
  return components;
}

function unionBbox(blocks: UnknownRecord[]): number[] {
  const boxes = blocks.map((block) => contractBbox(block.bbox_norm)).filter((value): value is number[] => Boolean(value));
  return [
    stableNumber(Math.min(...boxes.map((bbox) => bbox[0]))),
    stableNumber(Math.min(...boxes.map((bbox) => bbox[1]))),
    stableNumber(Math.max(...boxes.map((bbox) => bbox[2]))),
    stableNumber(Math.max(...boxes.map((bbox) => bbox[3])))
  ];
}

function markdownContext(blocks: UnknownRecord[], markdownImages: UnknownRecord[]): {
  imageIds: string[]; contiguous: boolean; coverage: number; maxGapChars: number | null;
} {
  const imageOrder = new Map<string, number>();
  const imageById = new Map<string, UnknownRecord>();
  for (const image of markdownImages) {
    if (typeof image.id === "string" && Number.isInteger(image.order)) imageOrder.set(image.id, Number(image.order));
    if (typeof image.id === "string") imageById.set(image.id, image);
  }
  const referencedBlockCount = blocks.filter((block) => stringList(block.markdown_image_ids).some((id) => imageOrder.has(id))).length;
  const imageIds = unique(blocks.flatMap((block) => stringList(block.markdown_image_ids)).filter((id) => imageOrder.has(id)))
    .sort((left, right) => imageOrder.get(left)! - imageOrder.get(right)!);
  const orders = imageIds.map((id) => imageOrder.get(id)!);
  let maxGapChars: number | null = null;
  if (imageIds.length >= 2) {
    const gaps: number[] = [];
    for (let index = 0; index < imageIds.length - 1; index += 1) {
      const leftEnd = imageById.get(imageIds[index])?.char_end;
      const rightStart = imageById.get(imageIds[index + 1])?.char_start;
      if (Number.isInteger(leftEnd) && Number.isInteger(rightStart)) gaps.push(Math.max(0, Number(rightStart) - Number(leftEnd)));
    }
    if (gaps.length === imageIds.length - 1) maxGapChars = gaps.length ? Math.max(...gaps) : 0;
  }
  const coverage = blocks.length ? referencedBlockCount / blocks.length : 0;
  return {
    imageIds,
    contiguous: orders.length >= 2 && Math.max(...orders) - Math.min(...orders) + 1 === orders.length
      && coverage >= 0.8 && maxGapChars !== null && maxGapChars <= 160,
    coverage,
    maxGapChars
  };
}

function componentsShareExtendedBand(left: UnknownRecord[], right: UnknownRecord[], gapThreshold = 40, overlapRatio = 0.65): boolean {
  const [lx0, ly0, lx1, ly1] = unionBbox(left);
  const [rx0, ry0, rx1, ry1] = unionBbox(right);
  const xGap = Math.max(0, Math.max(lx0, rx0) - Math.min(lx1, rx1));
  const yGap = Math.max(0, Math.max(ly0, ry0) - Math.min(ly1, ry1));
  const xOverlap = axisOverlap(lx0, lx1, rx0, rx1);
  const yOverlap = axisOverlap(ly0, ly1, ry0, ry1);
  return (yGap <= gapThreshold && xOverlap >= overlapRatio * Math.max(lx1 - lx0, rx1 - rx0))
    || (xGap <= gapThreshold && yOverlap >= overlapRatio * Math.max(ly1 - ly0, ry1 - ry0));
}

function mergeCaptionAnchoredComponents(components: UnknownRecord[][], markdownImages: UnknownRecord[]): UnknownRecord[][] {
  const working = components.map((component) => [...component].sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order)));
  working.sort((left, right) => unionBbox(left)[1] - unionBbox(right)[1] || unionBbox(left)[0] - unionBbox(right)[0]);
  while (working.length > 1) {
    let merged = false;
    for (let index = 0; index < working.length - 1; index += 1) {
      const left = working[index];
      const right = working[index + 1];
      if (!componentsShareExtendedBand(left, right)) continue;
      const combined = [...left, ...right].sort((a, b) => numberValue(a.page_order) - numberValue(b.page_order));
      if (combined.length < 3) continue;
      const anchors = combined.reduce((sum, block) => sum + numberValue(record(block.caption)?.figure_anchor_count), 0);
      if (anchors !== 1) continue;
      const context = markdownContext(combined, markdownImages);
      if (!context.contiguous || context.coverage < 0.8) continue;
      const area = bboxArea(unionBbox(combined)) / (COORDINATE_EXTENT ** 2);
      if (area < 0.03 || area > 0.8) continue;
      working.splice(index, 2, combined);
      working.sort((a, b) => unionBbox(a)[1] - unionBbox(b)[1] || unionBbox(a)[0] - unionBbox(b)[0]);
      merged = true;
      break;
    }
    if (!merged) break;
  }
  return working;
}

function nearestFollowingFormalCaption(component: UnknownRecord[], pageBlocks: UnknownRecord[]): UnknownRecord | null {
  if (!component.length) return null;
  const lastOrder = Math.max(...component.map((block) => numberValue(block.page_order, -1)));
  for (const block of [...pageBlocks].sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order))) {
    if (numberValue(block.page_order, -1) <= lastOrder || !["text", "title"].includes(String(block.role))) continue;
    if (typeof record(block.text)?.leading_formal_figure_caption_key === "string") return block;
  }
  return null;
}

function captionAdjacencyScore(captionBbox: number[], visualBbox: number[]): number | null {
  const captionWidth = captionBbox[2] - captionBbox[0];
  const visualWidth = visualBbox[2] - visualBbox[0];
  const sharedWidth = axisOverlap(captionBbox[0], captionBbox[2], visualBbox[0], visualBbox[2]);
  const overlapRatio = sharedWidth / Math.max(1, Math.min(captionWidth, visualWidth));
  if (overlapRatio < 0.55) return null;
  let gap: number;
  if (captionBbox[1] >= visualBbox[3] - 20) {
    gap = Math.max(0, captionBbox[1] - visualBbox[3]);
    if (gap > 100) return null;
  } else if (visualBbox[1] >= captionBbox[3] - 20) {
    gap = Math.max(0, visualBbox[1] - captionBbox[3]);
    if (gap > 80) return null;
  } else return null;
  return gap + (1 - overlapRatio) * 40;
}

function componentsAreCoordinateNeighbours(left: UnknownRecord[], right: UnknownRecord[]): boolean {
  const [lx0, ly0, lx1, ly1] = unionBbox(left);
  const [rx0, ry0, rx1, ry1] = unionBbox(right);
  const xGap = Math.max(0, Math.max(lx0, rx0) - Math.min(lx1, rx1));
  const yGap = Math.max(0, Math.max(ly0, ry0) - Math.min(ly1, ry1));
  const xOverlap = axisOverlap(lx0, lx1, rx0, rx1);
  const yOverlap = axisOverlap(ly0, ly1, ry0, ry1);
  return (xGap <= 65 && yOverlap >= 0.2 * Math.min(ly1 - ly0, ry1 - ry0))
    || (yGap <= 65 && xOverlap >= 0.2 * Math.min(lx1 - lx0, rx1 - rx0));
}

function mergeReadingOrderCaptionComponents(components: UnknownRecord[][], pageBlocks: UnknownRecord[]): UnknownRecord[][] {
  if (components.length < 2) return components;
  const anchors = components.map((component) => nearestFollowingFormalCaption(component, pageBlocks));
  const adjacency = new Map(components.map((_value, index) => [index, new Set<number>()]));
  components.forEach((left, leftIndex) => {
    const leftAnchor = anchors[leftIndex];
    if (!leftAnchor) return;
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const rightAnchor = anchors[rightIndex];
      if (!rightAnchor || rightAnchor.id !== leftAnchor.id || !componentsAreCoordinateNeighbours(left, components[rightIndex])) continue;
      adjacency.get(leftIndex)!.add(rightIndex);
      adjacency.get(rightIndex)!.add(leftIndex);
    }
  });
  const merged: UnknownRecord[][] = [];
  const visited = new Set<number>();
  for (let start = 0; start < components.length; start += 1) {
    if (visited.has(start)) continue;
    const pending = [start];
    const indexes: number[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      indexes.push(current);
      pending.push(...[...(adjacency.get(current) ?? [])].filter((value) => !visited.has(value)));
    }
    const combined = indexes.flatMap((index) => components[index]).sort((a, b) => numberValue(a.page_order) - numberValue(b.page_order));
    const anchor = anchors[indexes[0]];
    const captionBbox = anchor ? contractBbox(anchor.bbox_norm) : null;
    if (indexes.length > 1 && captionBbox && captionAdjacencyScore(captionBbox, unionBbox(combined)) !== null) merged.push(combined);
    else indexes.sort((a, b) => a - b).forEach((index) => merged.push(components[index]));
  }
  return merged.sort((left, right) => unionBbox(left)[1] - unionBbox(right)[1] || unionBbox(left)[0] - unionBbox(right)[0]);
}

function scoreVisualGroup(
  blocks: UnknownRecord[],
  representatives: UnknownRecord[],
  adjacencyEdges: UnknownRecord[],
  markdownImages: UnknownRecord[],
  replacementMode: "existing_asset" | "pdf_crop",
  standaloneCaptionAnchor = false
): UnknownRecord {
  const captionCharCount = blocks.reduce((sum, block) => sum + numberValue(record(block.caption)?.char_count), 0);
  const longCaptionAnchorCount = blocks.reduce((sum, block) => sum + numberValue(record(block.caption)?.long_item_count), 0);
  const figureCaptionAnchorCount = blocks.reduce((sum, block) => sum + numberValue(record(block.caption)?.figure_anchor_count), 0)
    + Number(standaloneCaptionAnchor);
  const panelLabelCount = blocks.reduce((sum, block) => sum + numberValue(record(block.caption)?.panel_label_count), 0);
  const markdown = markdownContext(blocks, markdownImages);
  const unionAreaFraction = bboxArea(unionBbox(representatives)) / (COORDINATE_EXTENT ** 2);
  const reasonCodes: string[] = [];
  const warningCodes: string[] = [];
  let confidence: number;
  if (replacementMode === "existing_asset") {
    const aliasCount = Math.max(0, blocks.length - 1);
    confidence = 0.78 + Math.min(0.12, aliasCount * 0.03);
    reasonCodes.push("enclosing_visual_asset");
    if (longCaptionAnchorCount) { confidence += 0.05; reasonCodes.push("long_caption_attached"); }
    if (markdown.contiguous) { confidence += 0.05; reasonCodes.push("markdown_references_contiguous"); }
    if (unionAreaFraction > 0.85 && aliasCount < 2) {
      confidence = Math.min(confidence, 0.79);
      warningCodes.push("near_full_page_enclosing_asset");
    }
  } else {
    confidence = 0.5 + (representatives.length >= 3 ? 0.15 : 0.08);
    if (adjacencyEdges.length >= Math.max(1, representatives.length - 1)) { confidence += 0.1; reasonCodes.push("same_page_connected_visuals"); }
    if (longCaptionAnchorCount) { confidence += 0.1; reasonCodes.push("long_caption_attached"); }
    if (panelLabelCount) { confidence += 0.05; reasonCodes.push("panel_labels_detected"); }
    if (standaloneCaptionAnchor) { confidence += 0.12; reasonCodes.push("standalone_figure_caption_after_visuals"); }
    if (markdown.contiguous) { confidence += 0.1; reasonCodes.push("markdown_references_contiguous"); }
    if (unionAreaFraction >= 0.03 && unionAreaFraction <= 0.8) { confidence += 0.05; reasonCodes.push("plausible_union_area"); }
    if (figureCaptionAnchorCount > 1) { confidence -= 0.25; warningCodes.push("multiple_figure_caption_anchors"); }
    else if (longCaptionAnchorCount > 2 && figureCaptionAnchorCount === 0) { confidence -= 0.15; warningCodes.push("multiple_long_caption_anchors"); }
    if (unionAreaFraction > 0.85) { confidence -= 0.2; warningCodes.push("near_full_page_union"); }
  }
  const strongCaptionEvidence = (longCaptionAnchorCount > 0 || standaloneCaptionAnchor) && figureCaptionAnchorCount === 1;
  const strongPanelGridEvidence = replacementMode === "pdf_crop" && representatives.length >= 4
    && adjacencyEdges.length >= representatives.length - 1 && panelLabelCount >= 2 && markdown.coverage >= 0.8;
  if (!strongCaptionEvidence && !strongPanelGridEvidence) {
    confidence = Math.min(confidence, 0.79);
    warningCodes.push("insufficient_figure_anchor_evidence");
  }
  if (figureCaptionAnchorCount > 1) {
    confidence = Math.min(confidence, 0.79);
    if (!warningCodes.includes("multiple_figure_caption_anchors")) warningCodes.push("multiple_figure_caption_anchors");
  } else if (longCaptionAnchorCount > 2 && figureCaptionAnchorCount === 0) {
    confidence = Math.min(confidence, 0.79);
    if (!warningCodes.includes("multiple_long_caption_anchors")) warningCodes.push("multiple_long_caption_anchors");
  }
  confidence = Number(Math.max(0, Math.min(0.99, confidence)).toFixed(3));
  return {
    confidence,
    decision: confidence >= 0.85 ? "auto" : confidence >= 0.65 ? "review" : "skip",
    markdown_image_ids: markdown.imageIds,
    signals: {
      member_count: blocks.length,
      representative_count: representatives.length,
      adjacent_pair_count: adjacencyEdges.length,
      caption_char_count: captionCharCount,
      long_caption_anchor_count: longCaptionAnchorCount,
      figure_caption_anchor_count: figureCaptionAnchorCount,
      panel_label_count: panelLabelCount,
      markdown_references_contiguous: markdown.contiguous,
      markdown_reference_coverage: Number(markdown.coverage.toFixed(4)),
      max_markdown_gap_chars: markdown.maxGapChars,
      union_area_fraction: Number(unionAreaFraction.toFixed(4))
    },
    reason_codes: reasonCodes,
    warning_codes: warningCodes
  };
}

function rootParent(blockId: string, parentByChild: Map<string, string>): string {
  const seen = new Set<string>();
  let current = blockId;
  while (parentByChild.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parentByChild.get(current)!;
  }
  return current;
}

function topTextBlock(block: UnknownRecord, y0Limit = 320): boolean {
  if (!["text", "title"].includes(String(block.role))) return false;
  const bbox = contractBbox(block.bbox_norm);
  return Boolean(bbox && bbox[1] <= y0Limit);
}

function sameTopCaptionBand(anchor: UnknownRecord, candidate: UnknownRecord): boolean {
  const anchorBbox = contractBbox(anchor.bbox_norm);
  const candidateBbox = contractBbox(candidate.bbox_norm);
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
  const bbox = contractBbox(block.bbox_norm);
  const text = record(block.text) ?? {};
  return Boolean(
    bbox
    && bbox[0] <= 200
    && bbox[1] <= 40
    && bbox[2] - bbox[0] <= 180
    && bbox[3] <= 65
    && !text.leading_figure_key
    && !text.leading_formal_figure_caption_key
  );
}

function scanNextPageCaptionCandidates(targetBlocks: UnknownRecord[], figureKey: string): {
  candidates: UnknownRecord[]; alternateKeys: string[]; boundary: string | null;
} {
  const candidates: UnknownRecord[] = [];
  const alternateKeys = new Set<string>();
  let boundary: string | null = null;
  for (const block of [...targetBlocks].sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order))) {
    const role = String(block.role);
    if (role === "marginalia" || (!candidates.length && runningPageHeader(block))) continue;
    if (role === "visual") { boundary = "visual_boundary"; break; }
    if (!["text", "title"].includes(role)) {
      if (["table", "equation"].includes(role)) { boundary = `${role}_boundary`; break; }
      continue;
    }
    if (blockCharCount(block) <= 0) continue;
    if (!topTextBlock(block)) { boundary = "body_band_boundary"; break; }
    const text = record(block.text) ?? {};
    const formalKey = text.leading_formal_figure_caption_key;
    const leadingKey = text.leading_figure_key;
    if (!candidates.length) {
      if (formalKey === figureKey) { candidates.push(block); continue; }
      if (typeof leadingKey === "string") {
        alternateKeys.add(leadingKey);
        boundary = leadingKey !== figureKey ? "different_figure_key" : "nonformal_figure_reference";
      } else boundary = role === "title" ? "title_boundary" : "body_text_boundary";
      break;
    }
    const anchor = candidates[0];
    if (formalKey === figureKey && sameTopCaptionBand(anchor, block)) {
      candidates.push(block);
      boundary = "duplicate_formal_caption_anchor";
      break;
    }
    if (typeof leadingKey === "string") {
      alternateKeys.add(leadingKey);
      boundary = leadingKey !== figureKey ? "different_figure_key" : "another_figure_anchor";
    } else boundary = role === "title" ? "title_boundary" : "body_text_boundary";
    break;
  }
  return { candidates, alternateKeys: [...alternateKeys].sort(), boundary };
}

function collectCrossPageCaptionBlocks(anchor: UnknownRecord, targetBlocks: UnknownRecord[]): {
  captionIds: string[]; status: "complete" | "partial"; reasonCodes: string[];
} {
  const captionIds = [String(anchor.id)];
  const reasonCodes: string[] = [];
  if (record(anchor.text)?.ends_with_terminal_punctuation === true) return { captionIds, status: "complete", reasonCodes };
  const ordered = [...targetBlocks].sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order));
  const anchorPosition = ordered.findIndex((block) => block.id === anchor.id);
  if (anchorPosition < 0) return { captionIds, status: "partial", reasonCodes: ["caption_anchor_missing_from_target_page"] };
  for (const continuation of ordered.slice(anchorPosition + 1)) {
    const role = String(continuation.role);
    if (role === "marginalia") continue;
    if (role === "visual") return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "visual_boundary_before_caption_continuation"] };
    if (!["text", "title"].includes(role)) {
      if (["table", "equation"].includes(role)) return { captionIds, status: "partial", reasonCodes: [...reasonCodes, `${role}_boundary_before_caption_continuation`] };
      continue;
    }
    const text = record(continuation.text) ?? {};
    if (blockCharCount(continuation) <= 0) {
      if (sameTopCaptionBand(anchor, continuation)) return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "empty_adjacent_caption_column"] };
      continue;
    }
    if (text.leading_figure_key !== null && text.leading_figure_key !== undefined) return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "new_figure_anchor_in_adjacent_column"] };
    if (role === "title") return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "title_band_in_adjacent_column"] };
    if (!sameTopCaptionBand(anchor, continuation)) return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "body_text_boundary_before_caption_continuation"] };
    if (text.starts_with_lowercase !== true && text.starts_with_panel_label !== true) return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "uncertain_adjacent_caption_continuation"] };
    captionIds.push(String(continuation.id));
    if (text.ends_with_terminal_punctuation === true) return { captionIds, status: "complete", reasonCodes };
    return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "unterminated_caption_continuation"] };
  }
  return { captionIds, status: "partial", reasonCodes: [...reasonCodes, "unterminated_caption_anchor"] };
}

function buildCrossPageCaptionLinks(viewerIndex: UnknownRecord): { links: UnknownRecord[]; issues: UnknownRecord[] } {
  const pages = new Map<number, UnknownRecord[]>();
  for (const pageValue of Array.isArray(viewerIndex.pages) ? viewerIndex.pages : []) {
    const page = record(pageValue);
    if (page && Number.isInteger(page.page_idx) && Array.isArray(page.blocks)) pages.set(Number(page.page_idx), page.blocks.map(record).filter(Boolean) as UnknownRecord[]);
  }
  const links: UnknownRecord[] = [];
  const issues: UnknownRecord[] = [];
  for (const sourcePageIndex of [...pages.keys()].sort((a, b) => a - b)) {
    for (const visual of pages.get(sourcePageIndex)!) {
      if (visual.role !== "visual" || !visual.asset_path || !contractBbox(visual.bbox_norm)) continue;
      const caption = record(visual.caption) ?? {};
      if (caption.next_page_marker !== true) continue;
      const figureKeys = stringList(caption.figure_keys);
      const markerKeys = stringList(caption.next_page_figure_keys);
      if (figureKeys.length !== 1 || markerKeys.length !== 1 || figureKeys[0] !== markerKeys[0]) {
        issues.push({ code: "ambiguous_visual_next_page_figure_key", visual_block_id: visual.id, source_page_idx: sourcePageIndex });
        continue;
      }
      const figureKey = figureKeys[0];
      const targetPageIndex = sourcePageIndex + 1;
      const targetBlocks = pages.get(targetPageIndex);
      if (!targetBlocks) {
        issues.push({ code: "next_page_figure_caption_not_found", visual_block_id: visual.id, source_page_idx: sourcePageIndex, target_page_idx: targetPageIndex, figure_key: figureKey });
        continue;
      }
      const scanned = scanNextPageCaptionCandidates(targetBlocks, figureKey);
      if (scanned.candidates.length > 1) {
        const issue: UnknownRecord = { code: "ambiguous_next_page_figure_caption", visual_block_id: visual.id, source_page_idx: sourcePageIndex, target_page_idx: targetPageIndex, figure_key: figureKey, candidate_count: scanned.candidates.length };
        if (scanned.boundary) issue.scan_boundary = scanned.boundary;
        issues.push(issue);
        continue;
      }
      if (!scanned.candidates.length) {
        const issue: UnknownRecord = { code: "next_page_figure_caption_not_found", visual_block_id: visual.id, source_page_idx: sourcePageIndex, target_page_idx: targetPageIndex, figure_key: figureKey };
        if (scanned.alternateKeys.length) issue.alternate_figure_keys = scanned.alternateKeys;
        if (scanned.boundary) issue.scan_boundary = scanned.boundary;
        issues.push(issue);
        continue;
      }
      const collected = collectCrossPageCaptionBlocks(scanned.candidates[0], targetBlocks);
      links.push({
        visual_block_id: visual.id,
        caption_block_ids: collected.captionIds,
        source_page_idx: sourcePageIndex,
        target_page_idx: targetPageIndex,
        figure_key: figureKey,
        relation: "next_page_figure_caption",
        status: collected.status
      });
      if (collected.status === "partial") issues.push({
        code: "partial_next_page_figure_caption",
        visual_block_id: visual.id,
        source_page_idx: sourcePageIndex,
        target_page_idx: targetPageIndex,
        figure_key: figureKey,
        reason_codes: collected.reasonCodes
      });
    }
  }
  return { links, issues };
}

export function buildMineruVisualRepair(viewerIndex: UnknownRecord): UnknownRecord {
  const markdownImages = (Array.isArray(viewerIndex.markdown_images) ? viewerIndex.markdown_images : []).map(record).filter(Boolean) as UnknownRecord[];
  let groups: UnknownRecord[] = [];
  const issues: UnknownRecord[] = [];
  let eligibleVisualCount = 0;
  for (const pageValue of Array.isArray(viewerIndex.pages) ? viewerIndex.pages : []) {
    const page = record(pageValue) ?? {};
    const pageIndex = page.page_idx;
    const pageBlocks = (Array.isArray(page.blocks) ? page.blocks : []).map(record).filter(Boolean) as UnknownRecord[];
    const visuals = visualBlocks(pageBlocks);
    eligibleVisualCount += visuals.length;
    if (!visuals.length) continue;
    const relations = findEnclosingVisuals(visuals);
    const parentByChild = new Map(relations.map((relation) => [String(relation.child_id), String(relation.parent_id)]));
    const byId = new Map(visuals.map((block) => [String(block.id), block]));
    const aliasesByRoot = new Map<string, UnknownRecord[]>();
    for (const childId of parentByChild.keys()) {
      const rootId = rootParent(childId, parentByChild);
      const child = byId.get(childId);
      if (byId.has(rootId) && child) aliasesByRoot.set(rootId, [...(aliasesByRoot.get(rootId) ?? []), child]);
    }
    const representatives = visuals.filter((block) => !parentByChild.has(String(block.id)));
    const components = mergeReadingOrderCaptionComponents(
      mergeCaptionAnchoredComponents(clusterVisualBlocks(representatives), markdownImages),
      pageBlocks
    );
    const pageCandidates: Array<{ bbox: number[]; component: UnknownRecord[]; members: UnknownRecord[] }> = [];
    for (const component of components) {
      const members = [...component, ...component.flatMap((representative) => aliasesByRoot.get(String(representative.id)) ?? [])];
      const uniqueMembers = [...new Map(members.map((block) => [String(block.id), block])).values()]
        .sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order));
      if (component.length === 1 && uniqueMembers.length === 1) continue;
      pageCandidates.push({ bbox: unionBbox(component), component, members: uniqueMembers });
    }
    pageCandidates.sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
    pageCandidates.forEach((candidate, groupOrder) => {
      const edges = buildVisualAdjacency(candidate.component);
      const followingCaption = nearestFollowingFormalCaption(candidate.component, pageBlocks);
      const followingCaptionBbox = followingCaption ? contractBbox(followingCaption.bbox_norm) : null;
      const attachedCaptionCount = candidate.members.reduce((sum, block) => sum + numberValue(record(block.caption)?.figure_anchor_count), 0);
      const standalone = attachedCaptionCount === 0 && Boolean(followingCaptionBbox && captionAdjacencyScore(followingCaptionBbox, candidate.bbox) !== null);
      const replacementMode = candidate.component.length === 1 && candidate.members.length > 1 ? "existing_asset" : "pdf_crop";
      const score = scoreVisualGroup(candidate.members, candidate.component, edges, markdownImages, replacementMode, standalone);
      const strictComponentCount = clusterVisualBlocks(candidate.component).length;
      const signals = record(score.signals) ?? {};
      const reasonCodes = stringList(score.reason_codes);
      if (strictComponentCount > 1) {
        signals.caption_anchored_component_count = strictComponentCount;
        reasonCodes.push("caption_anchored_spatial_bridge");
      }
      const replacement = replacementMode === "existing_asset"
        ? { mode: "existing_asset", block_id: candidate.component[0].id, asset_path: candidate.component[0].asset_path }
        : { mode: "pdf_crop", bbox_norm: candidate.bbox, padding_norm: 6 };
      const captionAnchorBlockIds = candidate.members.filter((block) => numberValue(record(block.caption)?.long_item_count) > 0).map((block) => block.id);
      if (standalone && followingCaption) captionAnchorBlockIds.push(followingCaption.id);
      groups.push({
        id: `vr-p${String(Number(pageIndex)).padStart(4, "0")}-g${String(groupOrder).padStart(4, "0")}`,
        page_idx: pageIndex,
        member_block_ids: candidate.members.map((block) => block.id),
        member_asset_paths: [...new Set(candidate.members.flatMap((block) => block.asset_path ? [String(block.asset_path)] : []))].sort(),
        member_markdown_image_ids: stringList(score.markdown_image_ids),
        caption_anchor_block_ids: captionAnchorBlockIds,
        decision: score.decision,
        confidence: score.confidence,
        replacement,
        signals,
        reason_codes: reasonCodes,
        warning_codes: stringList(score.warning_codes),
        fallback: "original_assets"
      });
    });
  }
  groups = mergeNestedVisualRepairGroups(groups, viewerIndex);
  const crossPage = buildCrossPageCaptionLinks(viewerIndex);
  issues.push(...crossPage.issues);
  let status: string;
  if (eligibleVisualCount === 0) { status = "unavailable"; issues.push({ code: "no_locatable_visual_blocks" }); }
  else status = viewerIndex.status === "complete" ? "complete" : "partial";
  const decisionCount = (decision: string) => groups.filter((group) => group.decision === decision).length;
  const linkCount = (linkStatus: string) => crossPage.links.filter((link) => link.status === linkStatus).length;
  return {
    schema_version: 1,
    algorithm_version: "visual-repair-v1.6",
    status,
    viewer_index: "viewer-index.json",
    inputs: viewerIndex.inputs ?? {},
    render_requirements: { pdf_crop_requires_original_pdf: true, fallback: "original_assets" },
    summary: {
      eligible_visual_count: eligibleVisualCount,
      group_count: groups.length,
      auto_group_count: decisionCount("auto"),
      review_group_count: decisionCount("review"),
      skipped_group_count: decisionCount("skip"),
      caption_link_count: crossPage.links.length,
      complete_caption_link_count: linkCount("complete"),
      partial_caption_link_count: linkCount("partial")
    },
    groups,
    caption_links: crossPage.links,
    issues
  };
}

const CANDIDATE_SAFE_ID = /^[A-Za-z0-9_.:\-]{1,200}$/;
const CANDIDATE_SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const CANDIDATE_FIGURE_KEY = /^(?:figure|extended-data-figure|supplementary-figure|supporting-figure|图):[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const CANDIDATE_FLOAT_KEYS = new Set([
  "base_confidence", "confidence", "containment", "markdown_reference_coverage",
  "minimum_accept_confidence", "nested_overlap_containment", "union_area_fraction"
]);
const SIGNAL_KEYS = [
  "member_count", "representative_count", "adjacent_pair_count", "caption_char_count",
  "long_caption_anchor_count", "figure_caption_anchor_count", "panel_label_count",
  "markdown_references_contiguous", "markdown_reference_coverage", "max_markdown_gap_chars",
  "union_area_fraction", "caption_anchored_component_count"
] as const;
const SUMMARY_KEYS = [
  "char_count", "item_count", "figure_keys", "leading_figure_key", "formal_figure_caption_keys",
  "leading_formal_figure_caption_key", "next_page_marker", "next_page_figure_keys",
  "next_page_reference_count", "starts_with_lowercase", "starts_with_panel_label",
  "ends_with_terminal_punctuation"
] as const;

function contractCanonicalJson(value: unknown, parentKey?: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite canonical JSON number");
    const encoded = JSON.stringify(value);
    return Number.isInteger(value) && parentKey && CANDIDATE_FLOAT_KEYS.has(parentKey) ? `${encoded}.0` : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => contractCanonicalJson(item)).join(",")}]`;
  const object = record(value);
  if (!object) throw new Error("Unsupported canonical JSON value");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${contractCanonicalJson(object[key], key)}`).join(",")}}`;
}

export function mineruCanonicalSha256(value: unknown): string {
  return sha256(contractCanonicalJson(value));
}

function candidatePackageSha256(payload: UnknownRecord): string {
  const { candidate_package_sha256: _digest, ...material } = payload;
  return mineruCanonicalSha256(material);
}

function inputHash(payload: UnknownRecord, name: string): string {
  const value = record(record(payload.inputs)?.[name])?.sha256;
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : "";
}

function requiredInputHash(payload: UnknownRecord, name: string): { hash: string; error: "missing" | "invalid" | null } {
  const inputs = record(payload.inputs);
  const hashRecord = record(inputs?.[name]);
  if (!inputs || !hashRecord || !("sha256" in hashRecord) || hashRecord.sha256 === null || hashRecord.sha256 === "") return { hash: "", error: "missing" };
  if (typeof hashRecord.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(hashRecord.sha256)) return { hash: "", error: "invalid" };
  return { hash: hashRecord.sha256.toLowerCase(), error: null };
}

function sourceBindings(viewerIndex: UnknownRecord, visualRepair: UnknownRecord): UnknownRecord {
  return {
    article: { sha256: inputHash(viewerIndex, "article") },
    mineru_result: { sha256: inputHash(viewerIndex, "mineru_result") },
    viewer_index_sha256: mineruCanonicalSha256(viewerIndex),
    visual_repair_sha256: mineruCanonicalSha256(visualRepair)
  };
}

function safeCandidateId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return CANDIDATE_SAFE_ID.test(normalized) ? normalized : null;
}

function safeFigureKey(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CANDIDATE_FIGURE_KEY.test(normalized) ? normalized : null;
}

function safeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CANDIDATE_IDS_PER_FIELD) throw new Error("Visual repair exceeds the candidate metadata limit");
  return [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter((item) => item && CANDIDATE_SAFE_CODE.test(item)))].sort();
}

function safeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CANDIDATE_IDS_PER_FIELD) throw new Error("Visual repair exceeds the candidate identifier limit");
  const result: string[] = [];
  value.forEach((item) => {
    const normalized = safeCandidateId(item);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  });
  return result;
}

function safeBbox(value: unknown): number[] | null {
  return contractBbox(value);
}

function safeSignals(value: unknown): UnknownRecord {
  const source = record(value);
  if (!source) return {};
  const result: UnknownRecord = {};
  for (const key of [...SIGNAL_KEYS].sort()) {
    const item = source[key];
    if (item === null || item === undefined) result[key] = null;
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
  }
  return result;
}

function safeSummary(value: unknown): UnknownRecord {
  const source = record(value);
  if (!source) return {};
  const result: UnknownRecord = {};
  for (const key of [...SUMMARY_KEYS].sort()) {
    const item = source[key];
    if (["figure_keys", "formal_figure_caption_keys", "next_page_figure_keys"].includes(key)) {
      if (Array.isArray(item) && item.length > MAX_CANDIDATE_KEYS_PER_BLOCK) {
        throw new Error("Visual repair exceeds the caption-key limit");
      }
      const keys = Array.isArray(item) ? item.map(safeFigureKey).filter((entry): entry is string => Boolean(entry)) : [];
      result[key] = unique(keys);
    } else if (["leading_figure_key", "leading_formal_figure_caption_key"].includes(key)) {
      const normalized = safeFigureKey(item);
      if (normalized) result[key] = normalized;
    } else if (["next_page_marker", "starts_with_lowercase", "starts_with_panel_label", "ends_with_terminal_punctuation"].includes(key)) {
      if (typeof item === "boolean") result[key] = item;
    } else if (Number.isInteger(item) && Number(item) >= 0) result[key] = item;
  }
  return result;
}

interface CandidateBlockLocation { pageIndex: number; block: UnknownRecord }

function pageAndBlockMaps(viewerIndex: UnknownRecord): { pages: Map<number, UnknownRecord[]>; blocks: Map<string, CandidateBlockLocation> } {
  const pages = new Map<number, UnknownRecord[]>();
  const blocks = new Map<string, CandidateBlockLocation>();
  const pageValues = Array.isArray(viewerIndex.pages) ? viewerIndex.pages : [];
  if (pageValues.length > MAX_VIEWER_PAGES) throw new Error("Viewer index exceeds the page limit");
  for (const pageValue of pageValues) {
    const page = record(pageValue);
    if (!page || !Number.isInteger(page.page_idx) || Number(page.page_idx) < 0 || !Array.isArray(page.blocks)) continue;
    if (page.blocks.length > MAX_BLOCKS_PER_PAGE) throw new Error("Viewer index page exceeds the block limit");
    const pageIndex = Number(page.page_idx);
    const validBlocks = page.blocks.map(record).filter(Boolean) as UnknownRecord[];
    pages.set(pageIndex, validBlocks);
    validBlocks.forEach((block) => {
      const blockId = safeCandidateId(block.id);
      if (blockId) blocks.set(blockId, { pageIndex, block });
    });
  }
  return { pages, blocks };
}

function candidateGeometry(blockId: string, blocks: Map<string, CandidateBlockLocation>): UnknownRecord | null {
  const located = blocks.get(blockId);
  if (!located) return null;
  const bbox = safeBbox(located.block.bbox_norm);
  const pageOrder = located.block.page_order;
  if (!bbox || !Number.isInteger(pageOrder)) return null;
  const rawRole = String(located.block.role ?? "other");
  const role = ["text", "title", "visual", "table", "equation", "discarded", "other"].includes(rawRole) ? rawRole : "other";
  return { block_id: blockId, page_idx: located.pageIndex, page_order: pageOrder, bbox_norm: bbox, role };
}

function withCandidateId(candidate: UnknownRecord, inputs: UnknownRecord): UnknownRecord {
  const prefix = candidate.kind === "fragment_group" ? "fragment" : "caption";
  const digest = mineruCanonicalSha256({ schema_version: 1, inputs, candidate });
  return { candidate_id: `${prefix}-${digest.slice(0, 24)}`, ...candidate };
}

class CandidateCollector {
  private readonly candidateById = new Map<string, UnknownRecord>();
  private readonly materialIds = new Map<string, string>();

  constructor(private readonly inputs: UnknownRecord) {}

  add(candidate: UnknownRecord): void {
    const materialKey = JSON.stringify(candidate);
    const existingId = this.materialIds.get(materialKey);
    if (existingId) {
      this.candidateById.set(existingId, { candidate_id: existingId, ...candidate });
      return;
    }
    if (this.candidateById.size >= MAX_VISUAL_CANDIDATES) {
      throw new Error("Visual repair exceeds the review-candidate limit");
    }
    const identified = withCandidateId(candidate, this.inputs);
    const candidateId = String(identified.candidate_id);
    this.materialIds.set(materialKey, candidateId);
    this.candidateById.set(candidateId, identified);
  }

  values(): UnknownRecord[] {
    return [...this.candidateById.values()];
  }
}

function fragmentCandidate(group: UnknownRecord, blocks: Map<string, CandidateBlockLocation>): UnknownRecord | null {
  if (group.decision !== "review") return null;
  const groupId = safeCandidateId(group.id);
  const pageIndex = group.page_idx;
  const memberIds = safeIds(group.member_block_ids);
  if (!groupId || !Number.isInteger(pageIndex) || Number(pageIndex) < 0 || memberIds.length < 2) return null;
  const geometry = memberIds.map((id) => candidateGeometry(id, blocks));
  if (geometry.some((item) => !item || item.page_idx !== pageIndex)) return null;
  const rawMode = record(group.replacement)?.mode;
  const mode = ["pdf_crop", "existing_asset", "none"].includes(String(rawMode)) ? rawMode : "none";
  const rawConfidence = group.confidence;
  const baseConfidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0;
  return {
    kind: "fragment_group",
    review_state: "review",
    repair_group_id: groupId,
    page_idx: pageIndex,
    member_block_ids: memberIds,
    replacement_mode: mode,
    base_confidence: Number(baseConfidence.toFixed(6)),
    evidence: {
      member_geometry: (geometry.filter(Boolean) as UnknownRecord[]).sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order) || compareCodeUnits(String(left.block_id), String(right.block_id))),
      caption_anchor_block_ids: safeIds(group.caption_anchor_block_ids),
      signals: safeSignals(group.signals),
      reason_codes: safeCodes(group.reason_codes),
      warning_codes: safeCodes(group.warning_codes)
    }
  };
}

function captionCandidate(input: {
  reviewState: string; visualBlockId: string; sourcePageIndex: number; targetPageIndex: number;
  figureKey: string; captionBlockIds: string[]; issueCode: string;
  blocks: Map<string, CandidateBlockLocation>;
}): UnknownRecord | null {
  const sourceGeometry = candidateGeometry(input.visualBlockId, input.blocks);
  const captionGeometry = input.captionBlockIds.map((id) => candidateGeometry(id, input.blocks));
  if (!sourceGeometry || sourceGeometry.page_idx !== input.sourcePageIndex || sourceGeometry.role !== "visual"
    || input.targetPageIndex !== input.sourcePageIndex + 1 || !input.captionBlockIds.length
    || captionGeometry.some((item) => !item || item.page_idx !== input.targetPageIndex)) return null;
  const sourceBlock = input.blocks.get(input.visualBlockId)!.block;
  const summaries = input.captionBlockIds.map((id) => safeSummary(input.blocks.get(id)!.block.text));
  return {
    kind: "cross_page_caption",
    review_state: input.reviewState,
    visual_block_id: input.visualBlockId,
    source_page_idx: input.sourcePageIndex,
    target_page_idx: input.targetPageIndex,
    figure_key: input.figureKey,
    caption_block_ids: input.captionBlockIds,
    evidence: {
      source_geometry: sourceGeometry,
      caption_geometry: (captionGeometry.filter(Boolean) as UnknownRecord[]).sort((left, right) => numberValue(left.page_order) - numberValue(right.page_order) || compareCodeUnits(String(left.block_id), String(right.block_id))),
      source_caption_summary: safeSummary(sourceBlock.caption),
      caption_text_summaries: summaries,
      issue_code: input.issueCode
    }
  };
}

function partialCaptionCandidates(
  visualRepair: UnknownRecord,
  blocks: Map<string, CandidateBlockLocation>,
  collector: CandidateCollector
): void {
  if (!Array.isArray(visualRepair.caption_links)) return;
  if (visualRepair.caption_links.length > MAX_CANDIDATE_INPUT_ITEMS) throw new Error("Visual repair exceeds the caption-link limit");
  for (const linkValue of visualRepair.caption_links) {
    const link = record(linkValue);
    if (!link || link.status !== "partial") continue;
    const visualId = safeCandidateId(link.visual_block_id);
    const figureKey = safeFigureKey(link.figure_key);
    if (!visualId || !figureKey || !Number.isInteger(link.source_page_idx) || !Number.isInteger(link.target_page_idx)) continue;
    const candidate = captionCandidate({
      reviewState: "partial", visualBlockId: visualId, sourcePageIndex: Number(link.source_page_idx), targetPageIndex: Number(link.target_page_idx),
      figureKey, captionBlockIds: safeIds(link.caption_block_ids), issueCode: "partial_next_page_figure_caption", blocks
    });
    if (candidate) collector.add(candidate);
  }
}

function formalKeys(block: UnknownRecord): Set<string> {
  const summary = record(block.text);
  if (!summary) return new Set();
  const keys = new Set<string>();
  const leading = safeFigureKey(summary.leading_formal_figure_caption_key);
  if (leading) keys.add(leading);
  if (Array.isArray(summary.formal_figure_caption_keys)) {
    if (summary.formal_figure_caption_keys.length > MAX_CANDIDATE_KEYS_PER_BLOCK) {
      throw new Error("Visual repair exceeds the caption-key limit");
    }
    summary.formal_figure_caption_keys.forEach((value) => {
      const key = safeFigureKey(value);
      if (key) keys.add(key);
    });
  }
  return keys;
}

function ambiguousCaptionCandidates(
  visualRepair: UnknownRecord,
  pages: Map<number, UnknownRecord[]>,
  blocks: Map<string, CandidateBlockLocation>,
  collector: CandidateCollector
): string[] {
  if (!Array.isArray(visualRepair.issues)) return [];
  if (visualRepair.issues.length > MAX_CANDIDATE_INPUT_ITEMS) throw new Error("Visual repair exceeds the issue limit");
  const issues: string[] = [];
  for (const issueValue of visualRepair.issues) {
    const issue = record(issueValue);
    if (!issue) continue;
    const issueCode = String(issue.code ?? "").trim().toLowerCase();
    if (!issueCode.startsWith("ambiguous_") || (!issueCode.includes("caption") && !issueCode.includes("next_page"))) continue;
    const visualId = safeCandidateId(issue.visual_block_id);
    const located = blocks.get(visualId ?? "");
    if (!visualId || !located) { issues.push("ambiguous_caption_source_not_locatable"); continue; }
    const sourcePage = Number.isInteger(issue.source_page_idx) ? Number(issue.source_page_idx) : located.pageIndex;
    const targetPage = Number.isInteger(issue.target_page_idx) ? Number(issue.target_page_idx) : sourcePage + 1;
    const sourceCaption = record(located.block.caption);
    const candidateKeys = new Set<string>();
    const issueKey = safeFigureKey(issue.figure_key);
    if (issueKey) candidateKeys.add(issueKey);
    if (sourceCaption) {
      const rawFigureKeys = Array.isArray(sourceCaption.figure_keys) ? sourceCaption.figure_keys : [];
      const rawMarkerKeys = Array.isArray(sourceCaption.next_page_figure_keys) ? sourceCaption.next_page_figure_keys : [];
      if (rawFigureKeys.length > MAX_CANDIDATE_KEYS_PER_BLOCK || rawMarkerKeys.length > MAX_CANDIDATE_KEYS_PER_BLOCK) {
        throw new Error("Visual repair exceeds the caption-key limit");
      }
      const figureKeys = new Set(rawFigureKeys.map(safeFigureKey).filter(Boolean) as string[]);
      const markerKeys = new Set(rawMarkerKeys.map(safeFigureKey).filter(Boolean) as string[]);
      figureKeys.forEach((key) => { if (markerKeys.has(key)) candidateKeys.add(key); });
    }
    let found = false;
    for (const targetBlock of pages.get(targetPage) ?? []) {
      const anchorId = safeCandidateId(targetBlock.id);
      if (!anchorId) continue;
      const targetKeys = formalKeys(targetBlock);
      for (const figureKey of [...candidateKeys].filter((key) => targetKeys.has(key)).sort()) {
        const candidate = captionCandidate({ reviewState: "ambiguous", visualBlockId: visualId, sourcePageIndex: sourcePage, targetPageIndex: targetPage, figureKey, captionBlockIds: [anchorId], issueCode, blocks });
        if (candidate) { collector.add(candidate); found = true; }
      }
    }
    if (!found) issues.push("ambiguous_caption_without_bounded_candidate");
  }
  return [...new Set(issues)].sort();
}

export function buildMineruVisualCandidates(viewerIndexValue: unknown, visualRepairValue: unknown, minimumAcceptConfidence = 0.85): UnknownRecord {
  const issues: string[] = [];
  const viewerIndex = record(viewerIndexValue) ?? {};
  const visualRepair = record(visualRepairValue) ?? {};
  if (!record(viewerIndexValue) || !record(visualRepairValue)) issues.push("inputs_must_be_objects");
  if (!Number.isFinite(minimumAcceptConfidence) || minimumAcceptConfidence < 0 || minimumAcceptConfidence > 1) {
    minimumAcceptConfidence = 0.85;
    issues.push("invalid_minimum_accept_confidence");
  }
  for (const [field, value] of [["groups", visualRepair.groups], ["caption links", visualRepair.caption_links], ["issues", visualRepair.issues]] as const) {
    if (Array.isArray(value) && value.length > MAX_CANDIDATE_INPUT_ITEMS) throw new Error(`Visual repair exceeds the ${field} limit`);
  }
  const inputs = sourceBindings(viewerIndex, visualRepair);
  const articleHash = inputHash(viewerIndex, "article");
  const mineruHash = inputHash(viewerIndex, "mineru_result");
  const repairArticle = requiredInputHash(visualRepair, "article");
  const repairMineru = requiredInputHash(visualRepair, "mineru_result");
  if (!articleHash || !mineruHash) issues.push("missing_viewer_input_hash");
  if (repairArticle.error) issues.push(`visual_repair_article_hash_${repairArticle.error}`);
  else if (repairArticle.hash !== articleHash) issues.push("article_hash_mismatch");
  if (repairMineru.error) issues.push(`visual_repair_mineru_result_hash_${repairMineru.error}`);
  else if (repairMineru.hash !== mineruHash) issues.push("mineru_result_hash_mismatch");
  const maps = pageAndBlockMaps(viewerIndex);
  const collector = new CandidateCollector(inputs);
  if (!issues.length) {
    for (const groupValue of Array.isArray(visualRepair.groups) ? visualRepair.groups : []) {
      const group = record(groupValue);
      const candidate = group ? fragmentCandidate(group, maps.blocks) : null;
      if (candidate) collector.add(candidate);
    }
    partialCaptionCandidates(visualRepair, maps.blocks, collector);
    issues.push(...ambiguousCaptionCandidates(visualRepair, maps.pages, maps.blocks, collector));
  }
  const candidates = collector.values().sort((left, right) => compareCodeUnits(String(left.kind), String(right.kind)) || compareCodeUnits(String(left.candidate_id), String(right.candidate_id)));
  if (candidates.length > MAX_VISUAL_CANDIDATES) throw new Error("Visual repair exceeds the review-candidate limit");
  const invalidCodes = new Set([
    "inputs_must_be_objects", "missing_viewer_input_hash", "visual_repair_article_hash_missing",
    "visual_repair_article_hash_invalid", "visual_repair_mineru_result_hash_missing",
    "visual_repair_mineru_result_hash_invalid", "article_hash_mismatch", "mineru_result_hash_mismatch"
  ]);
  const payload: UnknownRecord = {
    schema_version: 1,
    contract: "mineru-visual-candidates",
    status: issues.some((code) => invalidCodes.has(code)) ? "invalid" : candidates.length ? "ready" : "empty",
    inputs,
    policy: { allowed_verdicts: ["accept", "reject", "abstain"], minimum_accept_confidence: Number(minimumAcceptConfidence.toFixed(6)) },
    candidates,
    issues: [...new Set(issues)].sort()
  };
  payload.candidate_package_sha256 = candidatePackageSha256(payload);
  return payload;
}
