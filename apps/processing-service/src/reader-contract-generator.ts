import { createHash } from "node:crypto";

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

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  const object = record(value);
  return object ? Object.values(object).flatMap(flattenStrings) : [];
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
  const rawKind = match[1].trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const kind = rawKind.startsWith("extended data")
    ? "extended-data-figure"
    : rawKind.startsWith("supplementary")
      ? "supplementary-figure"
      : rawKind.startsWith("supporting")
        ? "supporting-figure"
        : rawKind === "图" ? "图" : "figure";
  return `${kind}:${match[2].trim().toLocaleLowerCase().replace(/\./g, "_")}`;
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
    return character === character.toLocaleLowerCase() && character !== character.toLocaleUpperCase();
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
  const sourceType = String(item.type ?? "unknown").trim().toLocaleLowerCase();
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
  return nestedByPage
    ? { items: payload.flatMap((page, pageIndex) => (page as unknown[]).map((item): [unknown, number] => [item, pageIndex])), nestedByPage }
    : { items: payload.map((item): [unknown, null] => [item, null]), nestedByPage };
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
    if (path) raw.push({ start: match.index, end: match.index + match[0].length, path, syntax: "markdown" });
  }
  HTML_IMAGE_RE.lastIndex = 0;
  while ((match = HTML_IMAGE_RE.exec(markdown))) {
    const path = normalizeAssetPath(match[1]);
    if (path) raw.push({ start: match.index, end: match.index + match[0].length, path, syntax: "html" });
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
