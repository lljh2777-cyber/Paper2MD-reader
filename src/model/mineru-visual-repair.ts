import { isSafeRelativePath } from "./contract-validation";
import { MinerUVisual } from "./mineru-content-list";
import { Diagnostic, NormalizedBBox } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

export interface RepairedMinerUVisual extends MinerUVisual {
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
    | { mode: "fragment-set"; assetPaths: string[] };
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

function markdownRange(block: UnknownRecord | undefined): { start: number; end: number; text: string } | undefined {
  if (!block) return undefined;
  const range = record(block.markdown_text_range);
  const text = record(block.text);
  if (
    range?.offset_unit !== "utf16-code-unit"
    || !Number.isInteger(range.start)
    || !Number.isInteger(range.end)
    || Number(range.start) < 0
    || Number(range.end) <= Number(range.start)
    || typeof text?.text !== "string"
    || !text.text.trim()
  ) return undefined;
  return { start: Number(range.start), end: Number(range.end), text: text.text };
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

function terminalCaption(block: UnknownRecord): boolean {
  const summary = record(block.text);
  return summary?.ends_with_terminal_punctuation === true;
}

function hasFormalCaption(block: UnknownRecord): boolean {
  const caption = record(block.caption);
  const text = record(block.text);
  return strings(caption?.formal_figure_caption_keys).length > 0
    || strings(text?.formal_figure_caption_keys).length > 0
    || Boolean(caption?.leading_formal_figure_caption_key)
    || Boolean(text?.leading_formal_figure_caption_key);
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
  pages.forEach((pageValue) => {
    const page = record(pageValue);
    if (!Array.isArray(page?.blocks)) return;
    page.blocks.forEach((blockValue) => {
      const block = record(blockValue);
      if (typeof block?.id === "string") {
        blockById.set(block.id, block);
        if (Number.isInteger(page?.page_idx)) pageByBlockId.set(block.id, Number(page.page_idx));
      }
    });
  });
  const visualByPath = new Map(input.visuals.map((visual) => [visual.path, visual]));
  const orderByPath = new Map(input.visuals.map((visual, index) => [visual.path, index]));
  const consumed = new Set<string>();
  const repaired: Array<{ order: number; visual: RepairedMinerUVisual }> = [];
  const rawGroups = Array.isArray(repair.groups) ? repair.groups : [];
  const captionLinks = Array.isArray(repair.caption_links) ? repair.caption_links : [];
  const rawRecords = Array.isArray(input.mineruPayload)
    ? input.mineruPayload.flatMap((value) => Array.isArray(value) ? value : [value]).map(record)
    : [];
  const sourceTextByBlockId = new Map<string, string>();
  blockById.forEach((block, id) => {
    const sourceIndex = Number(block.source_index);
    const raw = Number.isInteger(sourceIndex) ? rawRecords[sourceIndex] : undefined;
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (text) sourceTextByBlockId.set(id, text);
  });
  let fullPageConsolidationCount = 0;
  const consolidatedPages = new Set<number>();
  const syntheticGroups: UnknownRecord[] = [];
  const rawGroupRecords = rawGroups.map(record).filter((group): group is UnknownRecord => Boolean(group));
  const pageRecords = pages.map(record).filter((page): page is UnknownRecord => Boolean(page));
  for (const page of pageRecords) {
    if (!Number.isInteger(page.page_idx) || !Array.isArray(page.blocks)) continue;
    const pageIndex = Number(page.page_idx);
    const pageGroups = rawGroupRecords.filter((group) => Number(group.page_idx) === pageIndex);
    const autoGroups = pageGroups.filter((group) => group.decision === "auto");
    if (
      autoGroups.length < 2
      || pageGroups.length !== autoGroups.length
      || captionLinks.map(record).some((link) => Number(link?.source_page_idx) === pageIndex)
      || !input.articleMarkdown
      || !input.sourcePdfPath
    ) continue;

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

    const coveredIds = new Set(autoGroups.flatMap((group) => strings(group.member_block_ids)));
    if (coveredIds.size < Math.max(4, Math.ceil(meaningfulBlocks.length / 2))) continue;
    const labels = panelLabels(meaningfulBlocks)
      .map((label) => label.toLocaleLowerCase())
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
      const summary = record(block.text);
      return ["text", "title"].includes(String(block.role))
        && Number(block.page_order) === firstMeaningfulOrder
        && typeof summary?.leading_formal_figure_caption_key === "string"
        && Boolean(summary.leading_formal_figure_caption_key)
        && terminalCaption(block)
        && Array.isArray(block.bbox_norm)
        && Number(block.bbox_norm[1]) <= 320
        && typeof block.id === "string"
        && Boolean(sourceTextByBlockId.get(block.id));
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
  const autoGroupCountByPage = new Map<number, number>();
  groups.map(record).filter((group): group is UnknownRecord => group?.decision === "auto").forEach((group) => {
    if (!Number.isInteger(group.page_idx)) return;
    const page = Number(group.page_idx);
    autoGroupCountByPage.set(page, (autoGroupCountByPage.get(page) ?? 0) + 1);
  });
  let reviewCount = 0;

  const captionDetails = (memberIds: string[], blocks: UnknownRecord[], pageIndex: number, inferNextPage: boolean) => {
    const memberSet = new Set(memberIds);
    const links = captionLinks.map(record).filter((link): link is UnknownRecord => Boolean(link))
      .filter((link) => typeof link.visual_block_id === "string" && memberSet.has(link.visual_block_id));
    if (links.length === 0 && inferNextPage && autoGroupCountByPage.get(pageIndex) === 1 && input.articleMarkdown) {
      const nextPage = pages.map(record).find((page) => page?.page_idx === pageIndex + 1);
      const candidates = Array.isArray(nextPage?.blocks)
        ? nextPage.blocks.map(record).filter((block): block is UnknownRecord => {
          if (!block || !["text", "title"].includes(String(block.role))) return false;
          const summary = record(block.text);
          return typeof summary?.leading_formal_figure_caption_key === "string"
            && Boolean(summary.leading_formal_figure_caption_key)
            && typeof block.id === "string"
            && Boolean(sourceTextByBlockId.get(block.id));
        })
        : [];
      const firstMeaningfulOrder = Array.isArray(nextPage?.blocks)
        ? Math.min(...nextPage.blocks.map(record)
          .filter((block) => block && block.role !== "discarded" && block.role !== "marginalia")
          .map((block) => Number(block!.page_order))
          .filter(Number.isFinite))
        : Number.NaN;
      if (candidates.length === 1 && Number(candidates[0].page_order) === firstMeaningfulOrder) {
        const id = String(candidates[0].id);
        const caption = sourceTextByBlockId.get(id)!;
        const start = input.articleMarkdown.indexOf(caption);
        if (start >= 0 && input.articleMarkdown.indexOf(caption, start + caption.length) < 0) {
          return {
            caption,
            captionSourceRanges: [{ start, end: start + caption.length, text: caption }],
            captionPageIndex: pageIndex + 1,
            captionStatus: "complete" as const,
            panelLabels: panelLabels(blocks)
          };
        }
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
    const ranges = captionBlocks.map(markdownRange);
    if (ranges.some((range) => !range)) return { panelLabels: panelLabels(blocks) };
    const caption = captionIds.map((id) => sourceTextByBlockId.get(id) || blockCaptionText(blockById.get(id)))
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return {
      caption: caption || undefined,
      captionSourceRanges: ranges.filter((range): range is NonNullable<typeof range> => Boolean(range)),
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
    const paths = strings(group.member_asset_paths).length
      ? strings(group.member_asset_paths)
      : blocks.map((block) => block.asset_path).filter((value): value is string => typeof value === "string");
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
    } else {
      return;
    }
    const captionAnchorIds = strings(group.caption_anchor_block_ids);
    const captionBlocks = [...blocks, ...captionAnchorIds.map((id) => blockById.get(id)).filter((value): value is UnknownRecord => Boolean(value))];
    const linkedCaption = captionDetails(memberIds, blocks, Number.isInteger(group.page_idx) ? Number(group.page_idx) : anchor.pageIndex, true);
    const captionText = linkedCaption.caption || bestCaption(captionBlocks, memberVisuals);
    const pageIndex = Number.isInteger(group.page_idx) ? Number(group.page_idx) : anchor.pageIndex;
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
        captionSourceRanges: linkedCaption.captionSourceRanges,
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
    const linkedCaption = captionDetails(blockId ? [blockId] : [], [block], visual.pageIndex, false);
    const captionText = linkedCaption.caption || bestCaption([block], [visual]) || visual.captionText;
    repaired.push({
      order: index,
      visual: {
        ...visual,
        captionText,
        label: labelFromCaption(captionText, visual.label),
        memberAssetPaths: [visual.path],
        memberBlockIds: blockId ? [blockId] : undefined,
        memberMarkdownImageIds: strings(block.markdown_image_ids),
        captionSourceRanges: linkedCaption.captionSourceRanges,
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
      message: `已将 ${fullPageConsolidationCount} 个跨页图注的整页多面板视觉区域合并为单一显示对象。`
    });
  }
  if (reviewCount) {
    diagnostics.push({
      level: "warning",
      code: "mineru-visual-repair-review",
      message: `${reviewCount} 个不确定视觉组合未自动合并，继续显示原始图片。`
    });
  }
  return { visuals: repaired.map((item) => item.visual), diagnostics };
}
