import { isSafeRelativePath } from "./contract-validation";
import { ReaderAssetKind } from "./reader-contract";

interface MarkdownLine {
  text: string;
  start: number;
}

export interface ClippingVisual {
  id: string;
  kind: ReaderAssetKind;
  path: string;
  label: string;
  captionText?: string;
  placementBlockId: string;
  captionBlockId?: string;
}

export interface AdaptedClippingMarkdown {
  articleText: string;
  visuals: ClippingVisual[];
}

const MARKDOWN_IMAGE_LINE = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)\s*$/i;
const HTML_IMAGE_LINE = /^\s*<img\b([^>]*)>\s*$/i;
const HTML_SRC = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HTML_ALT = /\balt\s*=\s*["']([^"']*)["']/i;
const SUPPORTED_IMAGE = /\.(?:png|jpe?g|webp|gif|bmp)$/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function readableClippingCaption(value: string): string {
  return decodeEntities(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .replace(/(?:\*\*|__|~~|`)(.+?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function linesOf(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline < 0 ? markdown.length : newline + 1;
    lines.push({
      text: markdown.slice(start, newline < 0 ? markdown.length : newline).replace(/\r$/, ""),
      start
    });
    start = end;
  }
  return lines;
}

function withoutFrontmatter(markdown: string): string {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || !/^[-\w]+:\s*/m.test(match[1])) return markdown;
  return markdown.slice(match[0].length);
}

function normalizeAssetPath(value: string): string | undefined {
  let path = decodeEntities(value).trim().replace(/^<|>$/g, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the literal path when a percent escape is malformed.
  }
  path = path.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/, 1)[0];
  return SUPPORTED_IMAGE.test(path) && isSafeRelativePath(path) ? path : undefined;
}

function standaloneImage(line: string): { path: string; alt: string } | undefined {
  const markdown = MARKDOWN_IMAGE_LINE.exec(line);
  if (markdown) {
    const path = normalizeAssetPath(markdown[2] || markdown[3] || "");
    return path ? { path, alt: decodeEntities(markdown[1] || "").trim() } : undefined;
  }
  const html = HTML_IMAGE_LINE.exec(line);
  if (!html) return undefined;
  const path = normalizeAssetPath(HTML_SRC.exec(html[1])?.[1] || "");
  return path ? { path, alt: decodeEntities(HTML_ALT.exec(html[1])?.[1] || "").trim() } : undefined;
}

function looksLikeCaptionLine(value: string): boolean {
  const text = value.trim();
  return Boolean(text)
    && !/^(?:#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s|\[\^[^\]]+\]:|---+$|___+$)/.test(text)
    && !standaloneImage(text);
}

function explicitLabel(value: string): string {
  const normalized = decodeEntities(value).replace(/[_-]+/g, " ");
  const extended = /\bExtended\s+Data\s+Fig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
  if (extended) return `Extended Data Fig. ${extended[1]}`;
  const supplementary = /\bSupp(?:lementary)?\s+Fig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
  if (supplementary) return `Supplementary Fig. ${supplementary[1]}`;
  const figure = /\bFig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
  if (figure) return `Fig. ${figure[1]}`;
  const table = /\bTable\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
  if (table) return `Table ${table[1]}`;
  const chineseFigure = /(?:图|表)\s*([A-Za-z]?\d+[A-Za-z]?)/i.exec(normalized);
  return chineseFigure ? `${normalized.includes("表") ? "表" : "图"} ${chineseFigure[1]}` : "";
}

function stableId(prefix: "ast" | "slot" | "blk", sequence: number): string {
  return `${prefix}_${sequence.toString(16).padStart(24, "0")}`;
}

/**
 * Adapt Web Clipper-style Markdown for the Reader without rewriting the source file.
 * Only a standalone local image and its immediately adjacent caption paragraph are paired.
 */
export function adaptClippingMarkdown(markdown: string): AdaptedClippingMarkdown {
  const readingMarkdown = withoutFrontmatter(markdown);
  const lines = linesOf(readingMarkdown);
  const visuals: ClippingVisual[] = [];
  const insertions: Array<{ position: number; text: string }> = [];
  const labels = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const image = standaloneImage(lines[index].text);
    if (!image) continue;

    let captionStart = index + 1;
    while (captionStart < lines.length && !lines[captionStart].text.trim()) captionStart += 1;
    const captionLines: string[] = [];
    if (captionStart < lines.length && looksLikeCaptionLine(lines[captionStart].text)) {
      for (let cursor = captionStart; cursor < lines.length; cursor += 1) {
        const text = lines[cursor].text.trim();
        if (!text || !looksLikeCaptionLine(text)) break;
        captionLines.push(text);
      }
    }

    const captionText = readableClippingCaption(captionLines.join(" "));
    const decodedFilename = image.path.split("/").pop() || image.path;
    let label = explicitLabel(image.alt) || explicitLabel(captionText) || explicitLabel(decodedFilename);
    let fallback = visuals.length + 1;
    while (!label || labels.has(label.toLowerCase())) {
      label = `Fig. ${fallback}`;
      fallback += 1;
      if (!labels.has(label.toLowerCase())) break;
    }
    labels.add(label.toLowerCase());

    const sequence = visuals.length + 1;
    const visual: ClippingVisual = {
      id: stableId("ast", sequence),
      kind: /^(?:table|表)\b/i.test(label) ? "table" : "figure",
      path: image.path,
      label,
      captionText: captionText || undefined,
      placementBlockId: stableId("slot", sequence),
      captionBlockId: captionLines.length ? stableId("blk", sequence) : undefined
    };
    visuals.push(visual);
    insertions.push({
      position: lines[index].start,
      text: `<!-- p2md:slot id="${visual.placementBlockId}" asset="${visual.id}" -->\n`
    });
    if (visual.captionBlockId) {
      insertions.push({
        position: lines[captionStart].start,
        text: `<!-- p2md:block id="${visual.captionBlockId}" kind="caption" -->\n`
      });
    }
  }

  let articleText = readingMarkdown;
  insertions
    .sort((left, right) => right.position - left.position)
    .forEach((insertion) => {
      articleText = `${articleText.slice(0, insertion.position)}${insertion.text}${articleText.slice(insertion.position)}`;
    });
  return { articleText, visuals };
}
