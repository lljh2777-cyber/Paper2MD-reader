import { normalizeReaderPath } from "../filesystem/reader-file-system";
import { isSafeRelativePath } from "./contract-validation";
import { Diagnostic, NormalizedBBox, ReaderAssetKind } from "./reader-contract";

const VISUAL_TYPES = new Set(["image", "table", "chart"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

export interface MinerUVisual {
  id: string;
  kind: ReaderAssetKind;
  path: string;
  label: string;
  captionText?: string;
  pageIndex: number;
  bbox?: NormalizedBBox;
  placementBlockId?: string;
}

export interface MinerUContentListResult {
  version: "v1" | "v2";
  visuals: MinerUVisual[];
  diagnostics: Diagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromSpans(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  if (value.every((item) => typeof item === "string")) {
    return (value as string[]).map((item) => item.trim()).filter(Boolean).join("\n");
  }
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!isRecord(item)) return "";
    if (typeof item.content === "string") return item.content;
    return textFromSpans(item.children);
  }).join("").trim();
}

function captionFor(record: Record<string, unknown>, type: string): string | undefined {
  const content = isRecord(record.content) ? record.content : undefined;
  const captionCandidates = [
    record[`${type}_caption`],
    record.image_caption,
    record.table_caption,
    record.chart_caption,
    content?.[`${type}_caption`],
    content?.image_caption,
    content?.table_caption,
    content?.chart_caption,
    content?.caption
  ];
  const footnoteCandidates = [
    record[`${type}_footnote`],
    record.image_footnote,
    record.table_footnote,
    record.chart_footnote,
    content?.[`${type}_footnote`],
    content?.image_footnote,
    content?.table_footnote,
    content?.chart_footnote,
    content?.footnote
  ];
  const firstText = (candidates: unknown[]): string | undefined => {
    for (const candidate of candidates) {
      const text = textFromSpans(candidate);
      if (text) return text;
    }
    return undefined;
  };
  const caption = firstText(captionCandidates);
  const footnote = firstText(footnoteCandidates);
  if (caption || footnote) {
    return [...new Set([caption, footnote].filter((text): text is string => Boolean(text)))].join("\n");
  }
  const findNestedCaption = (value: unknown, depth: number): string | undefined => {
    if (depth > 4 || !isRecord(value)) return undefined;
    for (const [key, candidate] of Object.entries(value)) {
      if (key === "caption" || key.endsWith("_caption")) {
        const text = textFromSpans(candidate);
        if (text) return text;
      }
    }
    for (const candidate of Object.values(value)) {
      const nested = findNestedCaption(candidate, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };
  return findNestedCaption(content, 0);
}

function markdownCaptionAfterImage(lines: string[], imageLineIndex: number, visual: MinerUVisual, ordinal: number): string | undefined {
  const labelNumber = visual.label.match(/\b([A-Za-z0-9]+)\b\s*$/)?.[1] ?? String(ordinal);
  const escapedNumber = labelNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const captionStart = new RegExp(`^\\s*(?:fig(?:ure)?\\.?|table|chart)\\s*${escapedNumber}(?:\\b|[.:;-])`, "i");
  const searchEnd = Math.min(lines.length, imageLineIndex + 18);
  for (let index = imageLineIndex + 1; index < searchEnd; index += 1) {
    const line = lines[index];
    if (/!\[[^\]]*\]\(|<img\b/i.test(line)) break;
    if (!captionStart.test(line)) continue;
    const captionLines = [line.trim()];
    for (let following = index + 1; following < searchEnd; following += 1) {
      const next = lines[following].trim();
      if (!next || /^#{1,6}\s/.test(next) || /!\[[^\]]*\]\(|<img\b/i.test(next)) break;
      captionLines.push(next);
    }
    return captionLines.join("\n").replace(/ {2,}$/gm, "").trim();
  }
  return undefined;
}

function imagePathFor(record: Record<string, unknown>): string | undefined {
  const content = isRecord(record.content) ? record.content : undefined;
  const candidates: unknown[] = [
    record.img_path,
    record.image_path,
    content?.img_path,
    content?.image_path,
    content?.table_img_path,
    content?.chart_img_path
  ];
  const collectNestedPaths = (value: unknown, depth: number): void => {
    if (depth > 4 || !isRecord(value)) return;
    for (const [key, candidate] of Object.entries(value)) {
      if ((key === "img_path" || key === "image_path" || key.endsWith("_img_path")) && typeof candidate === "string") {
        candidates.push(candidate);
      } else if (isRecord(candidate)) {
        collectNestedPaths(candidate, depth + 1);
      } else if (Array.isArray(candidate)) {
        candidate.forEach((item) => collectNestedPaths(item, depth + 1));
      }
    }
  };
  collectNestedPaths(content, 0);
  const raw = candidates.find((value): value is string => typeof value === "string" && value.length > 0);
  if (!raw) return undefined;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the literal path; malformed percent escapes are rejected by path checks below.
  }
  const path = normalizeReaderPath(decoded.split(/[?#]/, 1)[0]);
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return isSafeRelativePath(path) && IMAGE_EXTENSIONS.has(extension) ? path : undefined;
}

function normalizedBBox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  const scale = Math.max(...value.map((item) => Math.abs(item as number))) <= 1 ? 1 : 1000;
  if (x1 < x0 || y1 < y0) return undefined;
  return { x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale };
}

function visualLabel(type: string, caption: string | undefined, ordinal: number): string {
  if (caption) {
    const match = caption.match(/^\s*((?:fig(?:ure)?\.?|table|chart)\s*[A-Za-z0-9._-]+)/i);
    if (match) return match[1].trim().replace(/[.:;-]+$/, "");
  }
  if (type === "table") return `Table ${ordinal}`;
  if (type === "chart") return `Chart ${ordinal}`;
  return `Figure ${ordinal}`;
}

function visualId(prefix: "ast" | "slot", index: number): string {
  return `${prefix}_${(index + 1).toString(16).padStart(24, "0")}`;
}

export function parseMinerUContentList(raw: unknown): MinerUContentListResult {
  if (!Array.isArray(raw)) throw new Error("MinerU content list must be an array");
  const version: "v1" | "v2" = raw.some(Array.isArray) ? "v2" : "v1";
  const diagnostics: Diagnostic[] = [];
  const records: Array<{ value: Record<string, unknown>; pageIndex: number }> = [];

  if (version === "v2") {
    raw.forEach((page, pageIndex) => {
      if (!Array.isArray(page)) return;
      page.forEach((value) => {
        if (isRecord(value)) records.push({ value, pageIndex });
      });
    });
  } else {
    raw.forEach((value) => {
      if (!isRecord(value)) return;
      const pageIndex = typeof value.page_idx === "number" && Number.isInteger(value.page_idx) && value.page_idx >= 0
        ? value.page_idx
        : 0;
      records.push({ value, pageIndex });
    });
  }

  const visuals: MinerUVisual[] = [];
  records.forEach(({ value, pageIndex }) => {
    const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
    if (!VISUAL_TYPES.has(type) || value.sub_type === "seal") return;
    const path = imagePathFor(value);
    if (!path) {
      diagnostics.push({
        level: "warning",
        code: "mineru-visual-path-invalid",
        message: `Skipped MinerU ${type} on page ${pageIndex + 1}: no safe local image path.`
      });
      return;
    }
    const captionText = captionFor(value, type);
    const ordinal = visuals.length + 1;
    visuals.push({
      id: visualId("ast", visuals.length),
      kind: type === "table" ? "table" : "figure",
      path,
      label: visualLabel(type, captionText, ordinal),
      captionText,
      pageIndex,
      bbox: normalizedBBox(value.bbox)
    });
  });

  return { version, visuals, diagnostics };
}

export function injectMinerUVisualAnchors(markdown: string, visuals: MinerUVisual[]): string {
  const lines = markdown.split(/\r?\n/);
  const insertions = new Map<number, string[]>();
  const claimedLines = new Set<number>();

  visuals.forEach((visual, index) => {
    const encodedPath = encodeURI(visual.path);
    const lineIndex = lines.findIndex((line, candidateIndex) =>
      !claimedLines.has(candidateIndex)
      && (line.includes(visual.path) || line.includes(encodedPath))
      && (/!\[[^\]]*\]\(/.test(line) || /<img\b/i.test(line))
    );
    if (lineIndex < 0) return;
    claimedLines.add(lineIndex);
    const markdownCaption = markdownCaptionAfterImage(lines, lineIndex, visual, index + 1);
    if (markdownCaption) {
      visual.captionText = markdownCaption;
      visual.label = visualLabel(visual.kind === "table" ? "table" : "image", markdownCaption, index + 1);
    }
    visual.placementBlockId = visualId("slot", index);
    const marker = `<!-- p2md:slot id="${visual.placementBlockId}" asset="${visual.id}" -->`;
    insertions.set(lineIndex, [...(insertions.get(lineIndex) ?? []), marker]);
  });

  return lines.flatMap((line, index) => [...(insertions.get(index) ?? []), line]).join("\n");
}
