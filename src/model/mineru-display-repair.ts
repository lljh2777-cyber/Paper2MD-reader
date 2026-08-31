import { Diagnostic } from "./reader-contract";
import { RepairedMinerUVisual } from "./mineru-visual-repair";
import { AFTER_MINERU_DISPLAY_REPAIR_VERSION } from "../../packages/after-mineru-contract/src/index";

type UnknownRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REPAIRS = 64;
const MAX_TEXT_LENGTH = 20_000;
const MAX_RAW_TEXT_DEPTH = 64;
const MAX_RAW_TEXT_NODES = 65_536;
const CAPTION_FIELDS = ["image_caption", "chart_caption", "table_caption"] as const;

export interface MinerUDisplayRepairEntry {
  id: string;
  target: "article" | "caption";
  sourceBlockId: string;
  pageIndex: number;
  sourceText: string;
  replacementMarkdown: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface MinerUDisplayRepairPlan {
  article: MinerUDisplayRepairEntry[];
  captions: MinerUDisplayRepairEntry[];
  diagnostics: Diagnostic[];
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function replacementCharacterCount(value: string): number {
  return [...value].filter((character) => character === "\uFFFD").length;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function uniqueRange(source: string, value: string): { start: number; end: number } | undefined {
  const start = source.indexOf(value);
  if (start < 0 || source.indexOf(value, start + value.length) >= 0) return undefined;
  return { start, end: start + value.length };
}

function flattenMinerURecords(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const nestedByPage = value.length > 0 && value.every(Array.isArray);
  return nestedByPage ? value.flatMap((entry) => entry as unknown[]) : [...value];
}

function ownValues(value: UnknownRecord): IterableIterator<unknown> {
  return (function* values() {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) yield value[key];
    }
  })();
}

function flattenRawStrings(value: unknown): string[] {
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
    if (visitedNodes > MAX_RAW_TEXT_NODES) throw new Error("MinerU 图注超过显示修复校验上限");
    const item = next.value;
    if (typeof item === "string") {
      const normalized = item.trim();
      if (normalized) strings.push(normalized);
      continue;
    }
    const object = record(item);
    if (!Array.isArray(item) && !object) continue;
    if (frame.depth >= MAX_RAW_TEXT_DEPTH) throw new Error("MinerU 图注嵌套超过显示修复校验上限");
    stack.push({ iterator: Array.isArray(item) ? item.values() : ownValues(object!), depth: frame.depth + 1 });
  }
  return strings;
}

function rawCaptionTexts(value: UnknownRecord): string[] {
  const content = record(value.content) ?? {};
  const strings: string[] = [];
  for (const field of CAPTION_FIELDS) {
    for (const container of [value, content]) {
      if (field in container) strings.push(...flattenRawStrings(container[field]));
    }
  }
  return strings;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function viewerBlocks(value: unknown): Map<string, { block: UnknownRecord; pageIndex: number }> | undefined {
  const viewer = record(value);
  if (!viewer || viewer.schema_version !== 1 || !Array.isArray(viewer.pages)) return undefined;
  const result = new Map<string, { block: UnknownRecord; pageIndex: number }>();
  for (const pageValue of viewer.pages) {
    const page = record(pageValue);
    const pageIndex = Number(page?.page_idx);
    if (!page || !Number.isInteger(pageIndex) || pageIndex < 0 || !Array.isArray(page.blocks)) return undefined;
    for (const blockValue of page.blocks) {
      const block = record(blockValue);
      const id = typeof block?.id === "string" ? block.id : "";
      if (!block || !SAFE_ID.test(id) || result.has(id)) return undefined;
      result.set(id, { block, pageIndex });
    }
  }
  return result;
}

function captionTexts(block: UnknownRecord): string[] {
  const caption = record(block.caption);
  if (!Array.isArray(caption?.items)) return [];
  return caption.items.flatMap((value) => {
    const item = record(value);
    return typeof item?.text === "string" ? [item.text] : [];
  });
}

/**
 * Validate an optional, manifest-bound display repair sidecar. Repairs are
 * authorized only by exact source text, source block identity, source hashes,
 * and a byte-verified source PDF. The immutable MinerU files are never edited.
 */
export async function prepareMinerUDisplayRepair(input: {
  contract: unknown;
  viewerIndex: unknown;
  mineruPayload: unknown;
  sourceArticle: string;
  articleHash: string;
  mineruHash: string;
  sourcePdfHash: string;
}): Promise<MinerUDisplayRepairPlan> {
  const contract = record(input.contract);
  const inputs = record(contract?.inputs);
  const articleInput = record(inputs?.article);
  const mineruInput = record(inputs?.mineru_result);
  const pdfInput = record(inputs?.source_pdf);
  const summary = record(contract?.summary);
  if (
    !contract
    || !exactKeys(contract, ["schema_version", "algorithm_version", "inputs", "repairs", "summary"])
    || contract.schema_version !== 1
    || contract.algorithm_version !== AFTER_MINERU_DISPLAY_REPAIR_VERSION
    || !SHA256.test(input.sourcePdfHash)
    || !inputs
    || !exactKeys(inputs, ["article", "mineru_result", "source_pdf"])
    || !articleInput
    || !exactKeys(articleInput, ["sha256"])
    || !mineruInput
    || !exactKeys(mineruInput, ["sha256"])
    || !pdfInput
    || !exactKeys(pdfInput, ["sha256"])
    || articleInput?.sha256 !== input.articleHash
    || mineruInput?.sha256 !== input.mineruHash
    || pdfInput?.sha256 !== input.sourcePdfHash
    || !Array.isArray(contract.repairs)
    || contract.repairs.length < 1
    || contract.repairs.length > MAX_REPAIRS
    || !summary
    || !exactKeys(summary, [
      "repair_count",
      "article_repair_count",
      "caption_repair_count",
      "replacement_characters_before",
      "replacement_characters_after"
    ])
  ) throw new Error("显示修复契约与当前 Markdown、MinerU JSON 或源 PDF 不匹配");

  const blocks = viewerBlocks(input.viewerIndex);
  const rawRecords = flattenMinerURecords(input.mineruPayload);
  if (!blocks || !rawRecords.length) throw new Error("显示修复契约无法绑定 Viewer 区块");

  const ids = new Set<string>();
  const entries: MinerUDisplayRepairEntry[] = [];
  for (const value of contract.repairs) {
    const repair = record(value);
    if (!repair || !exactKeys(repair, [
      "id",
      "target",
      "source_block_id",
      "page_index",
      "source_text",
      "replacement_markdown",
      "source_text_sha256",
      "replacement_markdown_sha256"
    ])) throw new Error("显示修复记录包含未知或缺失字段");
    const id = typeof repair.id === "string" ? repair.id : "";
    const target = repair.target;
    const sourceBlockId = typeof repair.source_block_id === "string" ? repair.source_block_id : "";
    const pageIndex = Number(repair.page_index);
    const sourceText = typeof repair.source_text === "string" ? repair.source_text : "";
    const replacementMarkdown = typeof repair.replacement_markdown === "string" ? repair.replacement_markdown : "";
    const sourceHash = typeof repair.source_text_sha256 === "string" ? repair.source_text_sha256 : "";
    const replacementHash = typeof repair.replacement_markdown_sha256 === "string" ? repair.replacement_markdown_sha256 : "";
    const bound = blocks.get(sourceBlockId);
    const sourceRange = uniqueRange(input.sourceArticle, sourceText);
    if (
      !SAFE_ID.test(id)
      || ids.has(id)
      || (target !== "article" && target !== "caption")
      || !SAFE_ID.test(sourceBlockId)
      || !bound
      || bound.pageIndex !== pageIndex
      || !sourceText
      || sourceText.length > MAX_TEXT_LENGTH
      || !replacementMarkdown
      || replacementMarkdown.length > MAX_TEXT_LENGTH
      || !sourceText.includes("\uFFFD")
      || replacementMarkdown.includes("\uFFFD")
      || !SHA256.test(sourceHash)
      || !SHA256.test(replacementHash)
      || !sourceRange
      || await sha256(sourceText) !== sourceHash
      || await sha256(replacementMarkdown) !== replacementHash
    ) throw new Error(`显示修复记录无效：${id || "<unknown>"}`);

    const sourceIndex = Number(bound.block.source_index);
    const raw = Number.isInteger(sourceIndex) && sourceIndex >= 0 ? record(rawRecords[sourceIndex]) : undefined;
    if (!raw) throw new Error(`显示修复记录没有唯一 MinerU 来源：${id}`);
    if (target === "article") {
      const rawText = typeof raw.text === "string" ? raw.text : "";
      if (!["text", "title"].includes(String(bound.block.role)) || !rawText.includes(sourceText)) {
        throw new Error(`正文修复记录未绑定原始文本区块：${id}`);
      }
    } else {
      const viewerMatches = captionTexts(bound.block).filter((text) => text === sourceText);
      const rawMatches = rawCaptionTexts(raw).filter((text) => text === sourceText);
      if (
        !["visual", "table"].includes(String(bound.block.role))
        || viewerMatches.length !== 1
        || rawMatches.length !== 1
      ) {
        throw new Error(`图注修复记录未绑定唯一原始图注：${id}`);
      }
    }
    ids.add(id);
    entries.push({
      id,
      target,
      sourceBlockId,
      pageIndex,
      sourceText,
      replacementMarkdown,
      sourceStart: sourceRange.start,
      sourceEnd: sourceRange.end
    });
  }

  const ordered = [...entries].sort((left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd);
  if (ordered.some((entry, index) => index > 0 && entry.sourceStart < ordered[index - 1].sourceEnd)) {
    throw new Error("显示修复记录的原文区间相互重叠");
  }
  const article = entries.filter((entry) => entry.target === "article");
  const captions = entries.filter((entry) => entry.target === "caption");
  const replacementCharactersBefore = entries.reduce(
    (count, entry) => count + replacementCharacterCount(entry.sourceText),
    0
  );
  const replacementCharactersAfter = entries.reduce(
    (count, entry) => count + replacementCharacterCount(entry.replacementMarkdown),
    0
  );
  if (
    nonnegativeInteger(summary.repair_count) !== entries.length
    || nonnegativeInteger(summary.article_repair_count) !== article.length
    || nonnegativeInteger(summary.caption_repair_count) !== captions.length
    || nonnegativeInteger(summary.replacement_characters_before) !== replacementCharactersBefore
    || nonnegativeInteger(summary.replacement_characters_after) !== replacementCharactersAfter
  ) throw new Error("显示修复契约摘要与已验证修复记录不一致");
  return {
    article,
    captions,
    diagnostics: [{
      level: "info",
      code: "mineru-display-repair-verified",
      message: `已验证 ${article.length} 处正文与 ${captions.length} 处图注的源 PDF 精确显示修复；源 Markdown 未修改。`
    }]
  };
}

export function applyMinerUDisplayCaptionRepairs(
  visuals: RepairedMinerUVisual[],
  plan: MinerUDisplayRepairPlan
): RepairedMinerUVisual[] {
  if (!plan.captions.length) return visuals;
  const claims = plan.captions.map((repair) => {
    const matches = visuals.flatMap((visual, index) => (
      visual.memberBlockIds?.includes(repair.sourceBlockId)
      && visual.captionText === repair.sourceText
        ? [index]
        : []
    ));
    if (matches.length !== 1) throw new Error(`图注显示修复无法绑定唯一视觉对象：${repair.id}`);
    return { repair, index: matches[0] };
  });
  const repaired = visuals.map((visual) => ({ ...visual }));
  claims.forEach(({ repair, index }) => {
    repaired[index].captionText = repair.replacementMarkdown;
  });
  return repaired;
}

export function applyMinerUDisplayArticleRepairs(
  projectedArticle: string,
  plan: MinerUDisplayRepairPlan
): string {
  let result = projectedArticle;
  for (const repair of plan.article) {
    const range = uniqueRange(result, repair.sourceText);
    if (!range) throw new Error(`正文显示修复不再具有唯一原文区间：${repair.id}`);
    result = `${result.slice(0, range.start)}${repair.replacementMarkdown}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * Materialize every verified display repair that remains in the projected
 * Markdown. Captions already removed by the visual projection stay removed;
 * retained captions are replaced exactly once so portable Markdown cannot
 * leak the known-bad source text.
 */
export function applyMinerUDisplayMarkdownRepairs(
  projectedArticle: string,
  plan: MinerUDisplayRepairPlan
): string {
  let result = applyMinerUDisplayArticleRepairs(projectedArticle, plan);
  for (const repair of plan.captions) {
    const first = result.indexOf(repair.sourceText);
    if (first < 0) continue;
    const range = uniqueRange(result, repair.sourceText);
    if (!range) throw new Error(`图注显示修复不再具有唯一原文区间：${repair.id}`);
    result = `${result.slice(0, range.start)}${repair.replacementMarkdown}${result.slice(range.end)}`;
  }
  return result;
}
