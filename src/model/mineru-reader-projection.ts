// Display-only projection adapted from the MIT-licensed Research Agent Reader workflow.
// It never writes to article.md and fails closed when an exact source relation cannot be proven.
import { isSafeRelativePath } from "./contract-validation";
import { RepairedMinerUVisual } from "./mineru-visual-repair";
import { Diagnostic } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

interface MarkdownImageRange {
  id: string;
  assetPath: string;
  start: number;
  end: number;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function hashMatches(value: unknown, articleHash: string, mineruHash: string): boolean {
  const inputs = record(value);
  const article = record(inputs?.article);
  const mineru = record(inputs?.mineru_result);
  return article?.sha256 === articleHash && mineru?.sha256 === mineruHash;
}

function normalizedPath(value: string): string | undefined {
  let decoded = value.trim().replace(/^<|>$/g, "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed percent escapes remain literal and fail the safe-path check.
  }
  const path = decoded.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/^\.\//, "");
  return isSafeRelativePath(path) ? path : undefined;
}

function imageTokenPath(token: string): string | undefined {
  const markdown = /^!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)$/s.exec(token);
  const html = /^<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>$/is.exec(token);
  return normalizedPath(markdown?.[1] || markdown?.[2] || html?.[1] || "");
}

function imageRanges(viewerIndex: unknown, markdown: string): Map<string, MarkdownImageRange> {
  const viewer = record(viewerIndex);
  const result = new Map<string, MarkdownImageRange>();
  if (!Array.isArray(viewer?.markdown_images)) return result;
  for (const value of viewer.markdown_images) {
    const image = record(value);
    if (
      typeof image?.id !== "string"
      || typeof image.asset_path !== "string"
      || !Number.isInteger(image.char_start)
      || !Number.isInteger(image.char_end)
    ) continue;
    const start = Number(image.char_start);
    const end = Number(image.char_end);
    if (start < 0 || end <= start || end > markdown.length) continue;
    const token = markdown.slice(start, end);
    const assetPath = normalizedPath(image.asset_path);
    if (!assetPath || imageTokenPath(token) !== assetPath || result.has(image.id)) continue;
    result.set(image.id, { id: image.id, assetPath, start, end });
  }
  return result;
}

function uniqueCaptionRange(markdown: string, caption: string, images: MarkdownImageRange[], allImages: MarkdownImageRange[]): Replacement | undefined {
  const text = caption.trim();
  if (text.length < 12 || !images.length) return undefined;
  const imageEnd = Math.max(...images.map((image) => image.end));
  const nextImage = allImages.filter((image) => image.start > imageEnd).sort((a, b) => a.start - b.start)[0];
  const bound = Math.min(markdown.length, nextImage?.start ?? imageEnd + 16000);
  const first = markdown.indexOf(text, imageEnd);
  if (first < imageEnd || first + text.length > bound) return undefined;
  if (markdown.indexOf(text, first + text.length) >= 0) return undefined;
  const gap = markdown.slice(imageEnd, first);
  if (gap.trim() || (gap.match(/\n\s*\n/g)?.length ?? 0) > 2) return undefined;
  return { start: first, end: first + text.length, value: "" };
}

function adjacentPanelLabelRanges(markdown: string, images: MarkdownImageRange[], labels: readonly string[]): Replacement[] {
  const allowed = new Set(labels.map((label) => label.trim()).filter((label) => /^[A-Za-z]{1,3}$/.test(label)));
  if (!allowed.size) return [];
  const replacements: Replacement[] = [];
  images.forEach((image) => {
    let cursor = markdown.lastIndexOf("\n", image.start - 1);
    let blankLines = 0;
    while (cursor >= 0 && blankLines <= 2) {
      const previousStart = markdown.lastIndexOf("\n", cursor - 1) + 1;
      const raw = markdown.slice(previousStart, cursor).replace(/\s+$/g, "");
      const label = raw.trim();
      if (!label) {
        blankLines += 1;
        cursor = previousStart - 1;
        continue;
      }
      if (allowed.has(label) && /^\s*$/.test(markdown.slice(cursor + 1, image.start))) {
        replacements.push({ start: previousStart, end: cursor, value: "" });
      }
      break;
    }
  });
  return replacements;
}

function exactCaptionSourceRanges(markdown: string, visual: RepairedMinerUVisual): Replacement[] | undefined {
  if (!visual.captionSourceRanges?.length) return [];
  const result: Replacement[] = [];
  for (const range of visual.captionSourceRanges) {
    if (
      range.start < 0
      || range.end <= range.start
      || range.end > markdown.length
      || markdown.slice(range.start, range.end) !== range.text
    ) return undefined;
    result.push({ start: range.start, end: range.end, value: "" });
  }
  return result;
}

function overlaps(left: Replacement, right: Replacement): boolean {
  return left.start < right.end && right.start < left.end;
}

export function projectMinerUReaderMarkdown(input: {
  markdown: string;
  visuals: RepairedMinerUVisual[];
  viewerIndex: unknown;
  articleHash: string;
  mineruHash: string;
}): { markdown: string; diagnostics: Diagnostic[] } {
  const viewer = record(input.viewerIndex);
  if (viewer?.schema_version !== 1 || !hashMatches(viewer.inputs, input.articleHash, input.mineruHash)) {
    return {
      markdown: input.markdown,
      diagnostics: [{
        level: "warning",
        code: "mineru-reader-projection-binding-invalid",
        message: "正文显示投影与当前原文哈希不匹配，已完整保留原始 Markdown。"
      }]
    };
  }

  const byId = imageRanges(viewer, input.markdown);
  const allImages = [...byId.values()].sort((left, right) => left.start - right.start);
  const claimed: Replacement[] = [];
  let projectedVisuals = 0;
  let projectedImages = 0;
  let projectedCaptions = 0;
  let skipped = 0;

  for (const visual of input.visuals) {
    // Proven footer/license badges are omitted only from visual navigation.
    // Their original Markdown occurrence remains visible and byte-identical.
    if (visual.hidden) continue;
    const ids = visual.memberMarkdownImageIds ?? [];
    const memberPaths = visual.memberAssetPaths ?? [];
    const images = ids.map((id) => byId.get(id));
    if (
      !visual.placementBlockId
      || !ids.length
      || ids.length !== new Set(ids).size
      || memberPaths.length !== new Set(memberPaths).size
      || ids.length !== memberPaths.length
      || images.some((image) => !image)
    ) {
      skipped += 1;
      continue;
    }
    const exactImages = images.filter((image): image is MarkdownImageRange => Boolean(image)).sort((a, b) => a.start - b.start);
    if (
      exactImages.some((image, index) => index > 0 && image.start < exactImages[index - 1].end)
      || exactImages.some((image) => !memberPaths.includes(image.assetPath))
      || memberPaths.some((path) => !exactImages.some((image) => image.assetPath === path))
    ) {
      skipped += 1;
      continue;
    }
    const anchor = exactImages[0];
    const assetId = visual.id.startsWith("ast_") ? visual.id : `ast_${visual.placementBlockId.slice(5)}`;
    const marker = `<!-- p2md:slot id="${visual.placementBlockId}" asset="${assetId}" -->\n`;
    const replacements: Replacement[] = exactImages.map((image, index) => ({
      start: image.start,
      end: image.end,
      value: index === 0 ? marker : ""
    }));
    let visualCaptionCount = 0;
    const sourceCaptionRanges = exactCaptionSourceRanges(input.markdown, visual);
    if (sourceCaptionRanges === undefined) {
      skipped += 1;
      continue;
    }
    if (sourceCaptionRanges.length) {
      replacements.push(...sourceCaptionRanges);
      visualCaptionCount = sourceCaptionRanges.length;
    } else {
      replacements.push(...adjacentPanelLabelRanges(input.markdown, exactImages, visual.panelLabels ?? []));
      if (visual.captionText) {
        const samePageCaption = uniqueCaptionRange(input.markdown, visual.captionText, exactImages, allImages);
        if (samePageCaption) {
          replacements.push(samePageCaption);
          visualCaptionCount = 1;
        }
      }
    }
    if (replacements.some((replacement) => claimed.some((existing) => overlaps(replacement, existing)))) {
      skipped += 1;
      continue;
    }
    claimed.push(...replacements);
    projectedVisuals += 1;
    projectedImages += exactImages.length;
    projectedCaptions += visualCaptionCount;
    void anchor;
  }

  let markdown = input.markdown;
  for (const replacement of claimed.sort((left, right) => right.start - left.start || right.end - left.end)) {
    markdown = `${markdown.slice(0, replacement.start)}${replacement.value}${markdown.slice(replacement.end)}`;
  }
  const diagnostics: Diagnostic[] = [{
    level: "info",
    code: "mineru-reader-projection-applied",
    message: `正文显示层已投影 ${projectedVisuals} 个视觉对象，隐藏 ${projectedImages} 个原始图片引用和 ${projectedCaptions} 段可验证图注；源 Markdown 未被修改。`
  }];
  if (skipped) diagnostics.push({
    level: "warning",
    code: "mineru-reader-projection-skipped",
    message: `${skipped} 个视觉对象因图片、图注或区间关系不唯一而保留原始正文显示。`
  });
  return { markdown, diagnostics };
}
