import { isSafeRelativePath } from "./contract-validation";
import type { Diagnostic, NormalizedBBox } from "./reader-contract";

type UnknownRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:\-]{1,200}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const CANDIDATE_KEYS = new Set([
  "schema_version", "contract", "status", "inputs", "policy", "candidates", "issues", "candidate_package_sha256"
]);
const FRAGMENT_KEYS = new Set([
  "candidate_id", "kind", "review_state", "repair_group_id", "page_idx", "member_block_ids",
  "replacement_mode", "base_confidence", "evidence"
]);
const CAPTION_KEYS = new Set([
  "candidate_id", "kind", "review_state", "visual_block_id", "source_page_idx", "target_page_idx",
  "figure_key", "caption_block_ids", "evidence"
]);
const SIDECAR_KEYS = new Set(["schema_version", "contract", "candidate_package_sha256", "decisions"]);
const DECISION_KEYS = new Set(["candidate_id", "verdict", "correction"]);
const FRAGMENT_CORRECTION_KEYS = new Set(["kind", "member_block_ids"]);
const CAPTION_CORRECTION_KEYS = new Set(["kind", "visual_block_id", "caption_block_ids"]);
const MAX_CANDIDATES = 128;
const MAX_DECISIONS = 128;
const MAX_GROUP_MEMBERS = 32;
const MAX_VIEWER_PAGES = 2048;
const MAX_BLOCKS_PER_PAGE = 512;
const MAX_INDEXED_BLOCKS = 8192;
const MAX_REVIEW_TEXT_CHARS = 2048;
export const MAX_VISUAL_REVIEW_SIDECAR_BYTES = 64 * 1024;

export type MinerUReviewVerdict = "accept" | "reject" | "abstain";

export interface MinerUVisualReviewBlock {
  id: string;
  pageIndex: number;
  pageOrder: number;
  role: "visual" | "text" | "title";
  bbox: NormalizedBBox;
  assetPath?: string;
  text?: string;
  formalFigureKey?: string;
}

export interface MinerUVisualReviewCandidate {
  id: string;
  kind: "fragment_group" | "cross_page_caption";
  pageIndex: number;
  memberBlockIds: string[];
  replacementMode?: "pdf_crop" | "existing_asset" | "none";
  repairGroupId?: string;
  targetPageIndex?: number;
  figureKey?: string;
  visualBlockId?: string;
  captionBlockIds?: string[];
  reviewState: string;
}

export interface MinerUVisualReviewDecision {
  candidate_id: string;
  verdict: MinerUReviewVerdict;
  correction: null | {
    kind: "fragment_group";
    member_block_ids: string[];
  } | {
    kind: "cross_page_caption";
    visual_block_id: string;
    caption_block_ids: string[];
  };
}

export interface MinerUVisualReviewSidecar {
  schema_version: 1;
  contract: "paper2md-user-visual-review";
  candidate_package_sha256: string;
  decisions: MinerUVisualReviewDecision[];
}

export interface MinerUVisualReview {
  packageHash: string;
  storageKey: string;
  candidates: MinerUVisualReviewCandidate[];
  blocks: MinerUVisualReviewBlock[];
  decisions: MinerUVisualReviewDecision[];
}

export interface MinerUVisualReviewPreview {
  valid: boolean;
  writesSidecar: false;
  candidateId: string;
  effect: "merge-fragments" | "link-caption" | "reject-candidate" | "leave-unchanged" | "invalid";
  requestedDecision: MinerUVisualReviewDecision;
  validatedDecision?: MinerUVisualReviewDecision;
  diagnostics: Diagnostic[];
}

export interface PreparedMinerUVisualReview {
  review?: MinerUVisualReview;
  visualRepair: unknown;
  diagnostics: Diagnostic[];
}

export interface PrepareMinerUVisualReviewInput {
  candidatePackage: unknown;
  viewerIndex: unknown;
  visualRepair: unknown;
  articleHash: string;
  mineruHash: string;
  mineruPayload?: unknown;
  articleMarkdown?: string;
  sourcePdfPath?: string;
  candidateFileHash: string;
  sidecar?: unknown;
}

const previewContexts = new WeakMap<MinerUVisualReview, Omit<PrepareMinerUVisualReviewInput, "sidecar">>();

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function exactKeys(value: UnknownRecord, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value.toLowerCase());
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => !safeId(item))) return undefined;
  const result = value as string[];
  return new Set(result).size === result.length ? [...result] : undefined;
}

export function visualReviewSidecarByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function bboxArray(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  const [x0, y0, x1, y1] = value as number[];
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > 1000 || y1 > 1000) return undefined;
  return [x0, y0, x1, y1];
}

function normalizedBbox(value: unknown): NormalizedBBox | undefined {
  const parsed = bboxArray(value);
  return parsed ? {
    x: parsed[0] / 1000,
    y: parsed[1] / 1000,
    width: (parsed[2] - parsed[0]) / 1000,
    height: (parsed[3] - parsed[1]) / 1000
  } : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite canonical JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (!object) throw new Error("Unsupported canonical JSON value");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

interface IndexedBlock {
  id: string;
  pageIndex: number;
  pageOrder: number;
  role: string;
  bbox: [number, number, number, number];
  assetPath?: string;
  markdownImageIds: string[];
  sourceText?: string;
  markdownTextRange?: { start: number; end: number };
  raw: UnknownRecord;
}

function sourceRecords(mineruPayload: unknown): Array<UnknownRecord | undefined> {
  return Array.isArray(mineruPayload)
    ? mineruPayload.flatMap((value) => Array.isArray(value) ? value : [value]).map(record)
    : [];
}

function exactMarkdownRange(block: UnknownRecord, sourceText: string, articleMarkdown: string | undefined): { start: number; end: number } | undefined {
  if (!articleMarkdown || !sourceText) return undefined;
  const range = record(block.markdown_text_range);
  if (
    range?.offset_unit === "utf16-code-unit"
    && safeInteger(range.start)
    && safeInteger(range.end)
    && range.end > range.start
    && range.end <= articleMarkdown.length
    && articleMarkdown.slice(range.start, range.end).trim() === sourceText
  ) return { start: range.start, end: range.end };
  const start = articleMarkdown.indexOf(sourceText);
  if (start < 0 || articleMarkdown.indexOf(sourceText, start + sourceText.length) >= 0) return undefined;
  return { start, end: start + sourceText.length };
}

function indexBlocks(viewerIndex: unknown, mineruPayload?: unknown, articleMarkdown?: string): Map<string, IndexedBlock> {
  const viewer = record(viewerIndex);
  const sources = sourceRecords(mineruPayload);
  const result = new Map<string, IndexedBlock>();
  if (!Array.isArray(viewer?.pages)) return result;
  if (viewer.pages.length > MAX_VIEWER_PAGES) throw new Error("viewer-index 页数超过人工审阅安全上限");
  const seenPages = new Set<number>();
  for (const pageValue of viewer.pages) {
    const page = record(pageValue);
    if (!page || !safeInteger(page.page_idx) || !Array.isArray(page.blocks)) continue;
    if (seenPages.has(page.page_idx)) throw new Error(`viewer-index 含重复页码 ${page.page_idx}`);
    seenPages.add(page.page_idx);
    if (page.blocks.length > MAX_BLOCKS_PER_PAGE) throw new Error(`viewer-index 第 ${page.page_idx + 1} 页块数量超过人工审阅安全上限`);
    const seenOrders = new Set<number>();
    for (const blockValue of page.blocks) {
      const block = record(blockValue);
      const id = block?.id;
      const box = bboxArray(block?.bbox_norm);
      const order = block?.page_order;
      if (!block || !safeId(id) || !box || !safeInteger(order)) continue;
      if (result.has(id)) throw new Error(`viewer-index 含重复 block ID：${id}`);
      if (seenOrders.has(order)) throw new Error(`viewer-index 第 ${page.page_idx + 1} 页含重复阅读顺序 ${order}`);
      seenOrders.add(order);
      if (result.size >= MAX_INDEXED_BLOCKS) throw new Error("viewer-index 块数量超过人工审阅安全上限");
      const rawMarkdownIds = strings(block.markdown_image_ids);
      const assetPath = typeof block.asset_path === "string" && isSafeRelativePath(block.asset_path) ? block.asset_path : undefined;
      const sourceIndex = Number(block.source_index);
      const source = Number.isSafeInteger(sourceIndex) ? sources[sourceIndex] : undefined;
      const sourceText = typeof source?.text === "string" ? source.text.trim() : "";
      result.set(id, {
        id,
        pageIndex: page.page_idx,
        pageOrder: order,
        role: typeof block.role === "string" ? block.role : "other",
        bbox: box,
        assetPath,
        markdownImageIds: rawMarkdownIds ?? [],
        sourceText: sourceText || undefined,
        markdownTextRange: sourceText ? exactMarkdownRange(block, sourceText, articleMarkdown) : undefined,
        raw: block
      });
    }
  }
  return result;
}

function geometryMatches(value: unknown, block: IndexedBlock): boolean {
  const geometry = record(value);
  return Boolean(
    geometry
    && exactKeys(geometry, new Set(["block_id", "page_idx", "page_order", "bbox_norm", "role"]))
    && geometry.block_id === block.id
    && geometry.page_idx === block.pageIndex
    && geometry.page_order === block.pageOrder
    && canonicalJson(geometry.bbox_norm) === canonicalJson(block.bbox)
    && geometry.role === block.role
  );
}

function inputBindingsValid(inputs: unknown, articleHash: string, mineruHash: string): boolean {
  const value = record(inputs);
  const article = record(value?.article);
  const mineru = record(value?.mineru_result);
  return Boolean(
    value
    && exactKeys(value, new Set(["article", "mineru_result", "viewer_index_sha256", "visual_repair_sha256"]))
    && article && exactKeys(article, new Set(["sha256"])) && article.sha256 === articleHash
    && mineru && exactKeys(mineru, new Set(["sha256"])) && mineru.sha256 === mineruHash
    && safeHash(value.viewer_index_sha256)
    && safeHash(value.visual_repair_sha256)
  );
}

function findRepairGroup(visualRepair: unknown, id: string): UnknownRecord | undefined {
  const repair = record(visualRepair);
  if (!Array.isArray(repair?.groups)) return undefined;
  const matches = repair.groups.map(record).filter((group): group is UnknownRecord => group?.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

async function parseCandidates(input: {
  payload: unknown;
  viewerIndex: unknown;
  visualRepair: unknown;
  articleHash: string;
  mineruHash: string;
  mineruPayload?: unknown;
  articleMarkdown?: string;
}): Promise<{ candidates: MinerUVisualReviewCandidate[]; blocks: Map<string, IndexedBlock> }> {
  const payload = record(input.payload);
  if (!payload || !exactKeys(payload, CANDIDATE_KEYS)) throw new Error("视觉候选包字段不完整或含额外字段");
  if (payload.schema_version !== 1 || payload.contract !== "mineru-visual-candidates") throw new Error("视觉候选包版本或类型不受支持");
  if (!["ready", "empty", "invalid"].includes(String(payload.status))) throw new Error("视觉候选包状态无效");
  if (!inputBindingsValid(payload.inputs, input.articleHash, input.mineruHash)) throw new Error("视觉候选包未绑定当前原文与 MinerU 结果");
  const policy = record(payload.policy);
  if (
    !policy
    || !exactKeys(policy, new Set(["allowed_verdicts", "minimum_accept_confidence"]))
    || canonicalJson(policy.allowed_verdicts) !== canonicalJson(["accept", "reject", "abstain"])
    || typeof policy.minimum_accept_confidence !== "number"
    || policy.minimum_accept_confidence < 0
    || policy.minimum_accept_confidence > 1
  ) throw new Error("视觉候选审阅策略无效");
  if (!Array.isArray(payload.issues) || payload.issues.some((value) => typeof value !== "string" || !SAFE_CODE.test(value))) {
    throw new Error("视觉候选问题代码无效");
  }
  if (!Array.isArray(payload.candidates) || payload.candidates.length > MAX_CANDIDATES) throw new Error("视觉候选数量超过安全上限");
  // The exact candidate bytes were already checked against manifest.json by
  // readVerifiedMinerUDerivedJson. Recomputing Python's canonical JSON digest
  // from JavaScript would incorrectly change integer-valued floats (1.0 → 1).
  if (!safeHash(payload.candidate_package_sha256)) throw new Error("视觉候选包规范哈希无效");
  const blocks = indexBlocks(input.viewerIndex, input.mineruPayload, input.articleMarkdown);
  const seen = new Set<string>();
  const candidates: MinerUVisualReviewCandidate[] = [];
  for (const [index, rawValue] of payload.candidates.entries()) {
    const candidate = record(rawValue);
    if (!candidate || !safeId(candidate.candidate_id) || seen.has(candidate.candidate_id)) throw new Error(`视觉候选 ${index + 1} 的 ID 无效或重复`);
    if (!candidate.candidate_id.startsWith(candidate.kind === "fragment_group" ? "fragment-" : "caption-")) {
      throw new Error(`视觉候选 ${index + 1} 的 ID 前缀无效`);
    }
    seen.add(candidate.candidate_id);
    if (candidate.kind === "fragment_group") {
      if (!exactKeys(candidate, FRAGMENT_KEYS) || candidate.review_state !== "review") throw new Error(`碎图候选 ${index + 1} 的结构无效`);
      const ids = strings(candidate.member_block_ids);
      if (!safeId(candidate.repair_group_id) || !safeInteger(candidate.page_idx) || !ids || ids.length < 2 || ids.length > MAX_GROUP_MEMBERS) {
        throw new Error(`碎图候选 ${index + 1} 的成员无效`);
      }
      const repairGroup = findRepairGroup(input.visualRepair, candidate.repair_group_id);
      if (!repairGroup || repairGroup.decision !== "review" || canonicalJson(strings(repairGroup.member_block_ids) ?? []) !== canonicalJson(ids)) {
        throw new Error(`碎图候选 ${index + 1} 与 visual-repair 不一致`);
      }
      const evidence = record(candidate.evidence);
      const geometry = Array.isArray(evidence?.member_geometry) ? evidence.member_geometry : [];
      if (geometry.length !== ids.length || ids.some((id, position) => {
        const block = blocks.get(id);
        return !block || block.pageIndex !== candidate.page_idx || !geometryMatches(geometry[position], block);
      })) throw new Error(`碎图候选 ${index + 1} 的几何证据无效`);
      if (!["pdf_crop", "existing_asset", "none"].includes(String(candidate.replacement_mode))) throw new Error(`碎图候选 ${index + 1} 的替换方式无效`);
      candidates.push({
        id: candidate.candidate_id,
        kind: "fragment_group",
        pageIndex: candidate.page_idx,
        memberBlockIds: ids,
        replacementMode: candidate.replacement_mode as MinerUVisualReviewCandidate["replacementMode"],
        repairGroupId: candidate.repair_group_id,
        reviewState: "review"
      });
    } else if (candidate.kind === "cross_page_caption") {
      if (!exactKeys(candidate, CAPTION_KEYS) || !safeInteger(candidate.source_page_idx) || !safeInteger(candidate.target_page_idx)) {
        throw new Error(`跨页图注候选 ${index + 1} 的结构无效`);
      }
      const ids = strings(candidate.caption_block_ids);
      const source = blocks.get(String(candidate.visual_block_id));
      const evidence = record(candidate.evidence);
      const captionGeometry = Array.isArray(evidence?.caption_geometry) ? evidence.caption_geometry : [];
      if (
        !safeId(candidate.visual_block_id)
        || !ids?.length
        || ids.length > 2
        || !safeId(candidate.figure_key)
        || candidate.target_page_idx !== candidate.source_page_idx + 1
        || !source
        || source.pageIndex !== candidate.source_page_idx
        || source.role !== "visual"
        || !geometryMatches(evidence?.source_geometry, source)
        || captionGeometry.length !== ids.length
        || ids.some((id, position) => {
          const block = blocks.get(id);
          return !block || block.pageIndex !== candidate.target_page_idx || !["text", "title"].includes(block.role) || !geometryMatches(captionGeometry[position], block);
        })
      ) throw new Error(`跨页图注候选 ${index + 1} 的几何证据无效`);
      candidates.push({
        id: candidate.candidate_id,
        kind: "cross_page_caption",
        pageIndex: candidate.source_page_idx,
        memberBlockIds: [candidate.visual_block_id, ...ids],
        targetPageIndex: candidate.target_page_idx,
        figureKey: typeof candidate.figure_key === "string" ? candidate.figure_key : undefined,
        visualBlockId: candidate.visual_block_id,
        captionBlockIds: ids,
        reviewState: typeof candidate.review_state === "string" ? candidate.review_state : "review"
      });
    } else {
      throw new Error(`视觉候选 ${index + 1} 的类型不受支持`);
    }
  }
  if (payload.status === "ready" && !candidates.length) throw new Error("视觉候选包标记为 ready，但不含候选");
  if (payload.status === "empty" && candidates.length) throw new Error("视觉候选包标记为 empty，但仍含候选");
  if (payload.status === "invalid") throw new Error("视觉候选包生成状态无效，已停止审阅");
  return { candidates, blocks };
}

function axisOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function boxesAdjacent(left: IndexedBlock, right: IndexedBlock): boolean {
  const [lx0, ly0, lx1, ly1] = left.bbox;
  const [rx0, ry0, rx1, ry1] = right.bbox;
  const xGap = Math.max(0, Math.max(lx0, rx0) - Math.min(lx1, rx1));
  const yGap = Math.max(0, Math.max(ly0, ry0) - Math.min(ly1, ry1));
  const xOverlap = axisOverlap(lx0, lx1, rx0, rx1);
  const yOverlap = axisOverlap(ly0, ly1, ry0, ry1);
  const narrow = (xGap <= 20 && yOverlap >= 0.15 * Math.min(ly1 - ly0, ry1 - ry0))
    || (yGap <= 20 && xOverlap >= 0.15 * Math.min(lx1 - lx0, rx1 - rx0));
  const broad = (xGap <= 40 && yOverlap >= 0.65 * Math.max(ly1 - ly0, ry1 - ry0))
    || (yGap <= 40 && xOverlap >= 0.65 * Math.max(lx1 - lx0, rx1 - rx0));
  return narrow || broad;
}

function boxesConflict(left: IndexedBlock, right: IndexedBlock): boolean {
  const intersection = axisOverlap(left.bbox[0], left.bbox[2], right.bbox[0], right.bbox[2])
    * axisOverlap(left.bbox[1], left.bbox[3], right.bbox[1], right.bbox[3]);
  const leftArea = (left.bbox[2] - left.bbox[0]) * (left.bbox[3] - left.bbox[1]);
  const rightArea = (right.bbox[2] - right.bbox[0]) * (right.bbox[3] - right.bbox[1]);
  return intersection / Math.min(leftArea, rightArea) > 0.92 && Math.max(leftArea, rightArea) / Math.min(leftArea, rightArea) < 1.35;
}

function figureKeys(block: IndexedBlock): Set<string> {
  const values = [record(block.raw.caption), record(block.raw.text)];
  const result = new Set<string>();
  values.forEach((summary) => {
    if (!summary) return;
    [summary.leading_formal_figure_caption_key, ...(Array.isArray(summary.formal_figure_caption_keys) ? summary.formal_figure_caption_keys : [])]
      .forEach((value) => {
        if (typeof value === "string" && value) result.add(value.toLowerCase());
      });
  });
  return result;
}

function validateCorrection(
  memberIds: string[],
  candidate: MinerUVisualReviewCandidate,
  blocks: Map<string, IndexedBlock>,
  visualRepair: unknown,
  claimed: Set<string>,
  sourcePdfPath?: string,
  allowOriginal = false
): UnknownRecord {
  if (memberIds.length < 2 || memberIds.length > MAX_GROUP_MEMBERS || new Set(memberIds).size !== memberIds.length) {
    throw new Error("正确组合必须选择 2–32 个不重复图块");
  }
  if (!allowOriginal && canonicalJson([...memberIds].sort()) === canonicalJson([...candidate.memberBlockIds].sort())) {
    throw new Error("新组合与原候选完全相同；请直接接受原候选或调整图块");
  }
  const members = memberIds.map((id) => blocks.get(id));
  if (members.some((block) => !block)) throw new Error("修复方案引用了不存在的图块");
  const selected = members as IndexedBlock[];
  if (selected.some((block) => block.pageIndex !== candidate.pageIndex || block.role !== "visual" || !block.assetPath)) {
    throw new Error("所有图块必须来自候选所在的同一页，并且必须是有效视觉块");
  }
  if (selected.some((block) => block.markdownImageIds.length !== 1) || new Set(selected.flatMap((block) => block.markdownImageIds)).size !== selected.length) {
    throw new Error("图块与 Markdown 图片引用不是一一对应，无法安全隐藏原始碎图");
  }
  if (selected.some((block) => claimed.has(block.id))) throw new Error("图块已被另一项自动修复或用户修复占用");
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (boxesConflict(selected[left], selected[right])) throw new Error("所选图块坐标几乎完全重叠，无法证明它们是不同面板");
    }
  }
  const connected = new Set<string>([selected[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    selected.forEach((block) => {
      if (connected.has(block.id)) return;
      if (selected.some((other) => connected.has(other.id) && boxesAdjacent(block, other))) {
        connected.add(block.id);
        changed = true;
      }
    });
  }
  if (connected.size !== selected.length) throw new Error("所选图块在版面坐标上不连通，可能属于不同图片");
  const union: [number, number, number, number] = [
    Math.min(...selected.map((block) => block.bbox[0])),
    Math.min(...selected.map((block) => block.bbox[1])),
    Math.max(...selected.map((block) => block.bbox[2])),
    Math.max(...selected.map((block) => block.bbox[3]))
  ];
  const unionArea = ((union[2] - union[0]) * (union[3] - union[1])) / 1_000_000;
  if (unionArea < 0.03 || unionArea > 0.85) throw new Error("组合区域占页面比例异常，已拒绝该修复方案");
  const keys = new Set(selected.flatMap((block) => [...figureKeys(block)]));
  if (keys.size > 1) throw new Error("所选图块包含互相冲突的正式 Figure 编号");
  const repair = record(visualRepair);
  const autoGroups = Array.isArray(repair?.groups) ? repair.groups.map(record).filter((group) => group?.decision === "auto") : [];
  const autoMembers = new Set(autoGroups.flatMap((group) => strings(group?.member_block_ids) ?? []));
  if (selected.some((block) => autoMembers.has(block.id))) throw new Error("所选图块已属于确定性自动修复组");
  const ordered = [...selected].sort((left, right) => left.pageOrder - right.pageOrder);
  ordered.forEach((block) => claimed.add(block.id));
  return {
    id: `user-${candidate.id}`,
    page_idx: candidate.pageIndex,
    member_block_ids: ordered.map((block) => block.id),
    member_asset_paths: ordered.map((block) => block.assetPath),
    member_markdown_image_ids: ordered.flatMap((block) => block.markdownImageIds),
    caption_anchor_block_ids: [],
    decision: "auto",
    confidence: 1,
    replacement: sourcePdfPath
      ? { mode: "pdf_crop", bbox_norm: union, padding_norm: 6 }
      : { mode: "fragment_set", fragments: ordered.map((block) => ({ asset_path: block.assetPath, bbox_norm: block.bbox })) },
    reason_codes: ["explicit_user_fragment_group", "runtime_geometry_revalidated"],
    fallback: "original_assets"
  };
}

function summary(block: IndexedBlock, area: "text" | "caption"): UnknownRecord | undefined {
  return record(block.raw[area]);
}

function summaryIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && safeId(item)).map((item) => item.toLowerCase()))]
    : [];
}

function leadingFormalFigureKey(block: IndexedBlock): string | undefined {
  const value = summary(block, "text")?.leading_formal_figure_caption_key;
  return typeof value === "string" && safeId(value) ? value.toLowerCase() : undefined;
}

function sourceNextPageFigureKey(block: IndexedBlock): string | undefined {
  const caption = summary(block, "caption");
  if (caption?.next_page_marker !== true) return undefined;
  const figureKeys = summaryIds(caption.figure_keys);
  const markerKeys = summaryIds(caption.next_page_figure_keys);
  const shared = figureKeys.filter((key) => markerKeys.includes(key));
  if (shared.length !== 1 || figureKeys.length !== 1 || markerKeys.length !== 1) return undefined;
  if (Array.isArray(caption.next_page_placeholders)) {
    const matching = caption.next_page_placeholders.map(record)
      .filter((item) => typeof item?.figure_key === "string" && item.figure_key.toLowerCase() === shared[0]);
    if (matching.length !== 1) return undefined;
  }
  return shared[0];
}

function sameTopCaptionBand(left: IndexedBlock, right: IndexedBlock): boolean {
  const [ax0, ay0, ax1, ay1] = left.bbox;
  const [bx0, by0, bx1, by1] = right.bbox;
  if (Math.abs(ay0 - by0) > 45 || axisOverlap(ax0, ax1, bx0, bx1) > 0) return false;
  const xGap = Math.max(0, Math.max(ax0, bx0) - Math.min(ax1, bx1));
  const aHeight = ay1 - ay0;
  const bHeight = by1 - by0;
  if (xGap > 80 || axisOverlap(ay0, ay1, by0, by1) < 0.55 * Math.min(aHeight, bHeight)) return false;
  const ratio = bHeight / aHeight;
  return ratio >= 0.45 && ratio <= 2.2;
}

function captionAlignedWithVisual(visual: IndexedBlock, caption: IndexedBlock): boolean {
  const overlap = axisOverlap(visual.bbox[0], visual.bbox[2], caption.bbox[0], caption.bbox[2]);
  const minimumWidth = Math.min(visual.bbox[2] - visual.bbox[0], caption.bbox[2] - caption.bbox[0]);
  const visualCenter = (visual.bbox[0] + visual.bbox[2]) / 2;
  const captionCenter = (caption.bbox[0] + caption.bbox[2]) / 2;
  return overlap >= 0.2 * minimumWidth || Math.abs(visualCenter - captionCenter) <= 180;
}

function captionLinkMatchesCandidate(link: UnknownRecord, candidate: MinerUVisualReviewCandidate): boolean {
  return candidate.kind === "cross_page_caption"
    && link.visual_block_id === candidate.visualBlockId
    && link.source_page_idx === candidate.pageIndex
    && link.target_page_idx === candidate.targetPageIndex
    && String(link.figure_key).toLowerCase() === candidate.figureKey?.toLowerCase()
    && canonicalJson(strings(link.caption_block_ids) ?? []) === canonicalJson(candidate.captionBlockIds ?? []);
}

function validateCaptionCorrection(
  visualBlockId: string,
  captionBlockIds: string[],
  candidate: MinerUVisualReviewCandidate,
  blocks: Map<string, IndexedBlock>,
  captionLinks: unknown[],
  allowOriginal = false
): UnknownRecord {
  if (candidate.kind !== "cross_page_caption") throw new Error("当前候选不是跨页图注关系");
  if (!safeId(visualBlockId) || captionBlockIds.length < 1 || captionBlockIds.length > 2 || new Set(captionBlockIds).size !== captionBlockIds.length) {
    throw new Error("跨页图注必须选择 1–2 个不重复文本块");
  }
  if (
    !allowOriginal
    && visualBlockId === candidate.visualBlockId
    && canonicalJson([...captionBlockIds].sort()) === canonicalJson([...(candidate.captionBlockIds ?? [])].sort())
  ) {
    throw new Error("新关系与原候选完全相同；请直接接受原候选");
  }
  const visual = blocks.get(visualBlockId);
  if (!visual || visual.pageIndex !== candidate.pageIndex || visual.role !== "visual" || !visual.assetPath) {
    throw new Error("来源必须是候选原页中的有效视觉块");
  }
  const figureKey = sourceNextPageFigureKey(visual);
  if (!figureKey) throw new Error("来源视觉块没有唯一、可验证的下一页 Figure 标记");
  const targetPageIndex = candidate.pageIndex + 1;
  const selected = captionBlockIds.map((id) => blocks.get(id));
  if (selected.some((block) => !block)) throw new Error("图注关系引用了不存在的文本块");
  const captions = (selected as IndexedBlock[]).sort((left, right) => left.pageOrder - right.pageOrder);
  if (captions.some((block) => block.pageIndex !== targetPageIndex || !["text", "title"].includes(block.role) || !block.sourceText)) {
    throw new Error("图注文本块必须来自紧邻下一页，并且必须含有原始文本");
  }
  if (captions.some((block) => !block.markdownTextRange)) {
    throw new Error("图注文本在 Markdown 中不是唯一精确区间，不能安全隐藏");
  }
  for (let index = 1; index < captions.length; index += 1) {
    const previous = captions[index - 1].markdownTextRange!;
    const current = captions[index].markdownTextRange!;
    if (current.start < previous.end) throw new Error("所选图注文本在 Markdown 中重叠或顺序冲突");
  }
  const anchor = captions[0];
  if (anchor.bbox[1] > 320 || leadingFormalFigureKey(anchor) !== figureKey) {
    throw new Error("首个文本块不是页面顶部且 Figure 编号匹配的正式图注");
  }
  if (!captionAlignedWithVisual(visual, anchor)) throw new Error("来源图片与目标图注的横向版面位置不一致");
  const targetBlocks = [...blocks.values()]
    .filter((block) => block.pageIndex === targetPageIndex)
    .sort((left, right) => left.pageOrder - right.pageOrder);
  const anchorPosition = targetBlocks.findIndex((block) => block.id === anchor.id);
  if (anchorPosition < 0) throw new Error("目标图注不在下一页阅读顺序中");
  for (const preceding of targetBlocks.slice(0, anchorPosition)) {
    if (["discarded", "marginalia"].includes(preceding.role) || !preceding.sourceText) continue;
    if (leadingFormalFigureKey(preceding) === figureKey && sameTopCaptionBand(preceding, anchor)) continue;
    throw new Error("目标图注之前存在正文、图片或其他 Figure 边界");
  }
  const anchorSummary = summary(anchor, "text");
  let status: "complete" | "partial" = anchorSummary?.ends_with_terminal_punctuation === true ? "complete" : "partial";
  if (captions.length === 2) {
    if (status === "complete") throw new Error("首个图注块已经完整，不能继续吸收后续正文");
    const continuation = captions[1];
    const afterAnchor = targetBlocks.slice(anchorPosition + 1).find((block) => (
      !["discarded", "marginalia"].includes(block.role) && (Boolean(block.sourceText) || ["visual", "table", "equation"].includes(block.role))
    ));
    if (!afterAnchor || afterAnchor.id !== continuation.id) throw new Error("所选续接块不是图注后的第一个有效阅读块");
    const continuationSummary = summary(continuation, "text");
    if (
      continuation.role !== "text"
      || !sameTopCaptionBand(anchor, continuation)
      || Boolean(continuationSummary?.leading_figure_key)
      || (!Boolean(continuationSummary?.starts_with_lowercase) && !Boolean(continuationSummary?.starts_with_panel_label))
    ) throw new Error("续接块不满足同一顶部图注栏、连续小写或面板标签规则");
    status = continuationSummary?.ends_with_terminal_punctuation === true ? "complete" : "partial";
  }
  const existing = captionLinks.map(record).filter((link): link is UnknownRecord => Boolean(link));
  if (existing.some((link) => link.visual_block_id === visual.id)) throw new Error("来源视觉块已绑定另一条跨页图注关系");
  const usedCaptions = new Set(existing.flatMap((link) => strings(link.caption_block_ids) ?? []));
  if (captions.some((block) => usedCaptions.has(block.id))) throw new Error("所选文本块已被另一条跨页图注关系占用");
  return {
    visual_block_id: visual.id,
    caption_block_ids: captions.map((block) => block.id),
    source_page_idx: visual.pageIndex,
    target_page_idx: targetPageIndex,
    figure_key: figureKey,
    relation: "next_page_figure_caption",
    status
  };
}

function parseSidecar(value: unknown, packageHash: string, candidates: MinerUVisualReviewCandidate[]): MinerUVisualReviewSidecar {
  if (value === undefined || value === null) return {
    schema_version: 1,
    contract: "paper2md-user-visual-review",
    candidate_package_sha256: packageHash,
    decisions: []
  };
  if (visualReviewSidecarByteLength(value) > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
    throw new Error("用户视觉修复 sidecar 超过 64 KiB 安全上限");
  }
  const sidecar = record(value);
  if (!sidecar || !exactKeys(sidecar, SIDECAR_KEYS) || sidecar.schema_version !== 1 || sidecar.contract !== "paper2md-user-visual-review") {
    throw new Error("用户视觉修复 sidecar 结构无效");
  }
  if (sidecar.candidate_package_sha256 !== packageHash) throw new Error("用户视觉修复已过期，未绑定当前候选包");
  if (!Array.isArray(sidecar.decisions) || sidecar.decisions.length > MAX_DECISIONS) throw new Error("用户视觉修复决定超过安全上限");
  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const decisions: MinerUVisualReviewDecision[] = [];
  for (const [index, rawValue] of sidecar.decisions.entries()) {
    const decision = record(rawValue);
    if (!decision || !exactKeys(decision, DECISION_KEYS) || !safeId(decision.candidate_id) || seen.has(decision.candidate_id)) {
      throw new Error(`用户视觉修复决定 ${index + 1} 的结构或 ID 无效`);
    }
    const candidate = known.get(decision.candidate_id);
    if (!candidate) throw new Error(`用户视觉修复决定 ${index + 1} 引用了未知候选`);
    if (!["accept", "reject", "abstain"].includes(String(decision.verdict))) throw new Error(`用户视觉修复决定 ${index + 1} 的操作无效`);
    let correction: MinerUVisualReviewDecision["correction"] = null;
    if (decision.correction !== null) {
      const value = record(decision.correction);
      if (value?.kind === "fragment_group") {
        const memberIds = strings(value.member_block_ids);
        if (!exactKeys(value, FRAGMENT_CORRECTION_KEYS) || !memberIds || memberIds.length < 2 || memberIds.length > MAX_GROUP_MEMBERS) {
          throw new Error(`用户视觉修复决定 ${index + 1} 含坐标、路径、正文或其他未允许字段`);
        }
        if (decision.verdict !== "reject" || candidate.kind !== "fragment_group") {
          throw new Error("只有拒绝碎图候选时才能提交替代组合");
        }
        correction = { kind: "fragment_group", member_block_ids: memberIds };
      } else if (value?.kind === "cross_page_caption") {
        const captionIds = strings(value.caption_block_ids);
        if (!exactKeys(value, CAPTION_CORRECTION_KEYS) || !safeId(value.visual_block_id) || !captionIds || captionIds.length < 1 || captionIds.length > 2) {
          throw new Error(`用户视觉修复决定 ${index + 1} 含坐标、路径、正文或其他未允许字段`);
        }
        if (decision.verdict !== "reject" || candidate.kind !== "cross_page_caption") {
          throw new Error("只有拒绝跨页图注候选时才能提交替代关系");
        }
        correction = {
          kind: "cross_page_caption",
          visual_block_id: value.visual_block_id,
          caption_block_ids: captionIds
        };
      } else {
        throw new Error(`用户视觉修复决定 ${index + 1} 的替代修复类型无效`);
      }
    }
    seen.add(decision.candidate_id);
    decisions.push({
      candidate_id: decision.candidate_id,
      verdict: decision.verdict as MinerUReviewVerdict,
      correction
    });
  }
  return { schema_version: 1, contract: "paper2md-user-visual-review", candidate_package_sha256: packageHash, decisions };
}

export function visualReviewStorageKey(packageHash: string): string {
  if (!safeHash(packageHash)) throw new Error("视觉候选文件哈希无效");
  return `paper2md-reader:visual-review:v2:${packageHash.toLowerCase()}`;
}

export function createVisualReviewSidecar(packageHash: string, decisions: MinerUVisualReviewDecision[]): MinerUVisualReviewSidecar {
  if (!safeHash(packageHash)) throw new Error("视觉候选文件哈希无效");
  return {
    schema_version: 1,
    contract: "paper2md-user-visual-review",
    candidate_package_sha256: packageHash.toLowerCase(),
    decisions
  };
}

export async function prepareMinerUVisualReview(input: PrepareMinerUVisualReviewInput): Promise<PreparedMinerUVisualReview> {
  const diagnostics: Diagnostic[] = [];
  try {
    const parsed = await parseCandidates({
      payload: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash: input.articleHash,
      mineruHash: input.mineruHash,
      mineruPayload: input.mineruPayload,
      articleMarkdown: input.articleMarkdown
    });
    if (!safeHash(input.candidateFileHash)) throw new Error("visual-candidates.json 缺少 manifest 验证文件哈希");
    const packageHash = input.candidateFileHash.toLowerCase();
    let sidecar: MinerUVisualReviewSidecar;
    try {
      sidecar = parseSidecar(input.sidecar, packageHash, parsed.candidates);
    } catch (error) {
      diagnostics.push({
        level: "warning",
        code: "mineru-user-review-sidecar-invalid",
        message: `用户视觉修复记录无效，已忽略：${error instanceof Error ? error.message : String(error)}`
      });
      sidecar = createVisualReviewSidecar(packageHash, []);
    }
    const repair = record(input.visualRepair);
    if (!repair) throw new Error("visual-repair.json 必须是对象");
    const cloned = structuredClone(repair);
    const groups = Array.isArray(cloned.groups) ? cloned.groups : [];
    let captionLinks = Array.isArray(cloned.caption_links) ? cloned.caption_links : [];
    const rejectedCaptionCandidates = new Set(sidecar.decisions
      .filter((decision) => decision.verdict === "reject")
      .map((decision) => decision.candidate_id));
    const originalCaptionLinkCount = captionLinks.length;
    captionLinks = captionLinks.filter((link) => {
      const raw = record(link);
      if (!raw) return true;
      return !parsed.candidates.some((candidate) => (
        rejectedCaptionCandidates.has(candidate.id) && captionLinkMatchesCandidate(raw, candidate)
      ));
    });
    const claimed = new Set<string>();
    groups.map(record).filter((group): group is UnknownRecord => group?.decision === "auto").forEach((group) => {
      (strings(group.member_block_ids) ?? []).forEach((id) => claimed.add(id));
    });
    let applied = 0;
    const visibleDecisions: MinerUVisualReviewDecision[] = [];
    for (const decision of sidecar.decisions) {
      const candidate = parsed.candidates.find((item) => item.id === decision.candidate_id)!;
      let visibleDecision = decision;
      if (decision.verdict === "accept" && candidate.kind === "fragment_group") {
        const groupIndex = groups.findIndex((item) => record(item)?.id === candidate.repairGroupId);
        const group = groupIndex >= 0 ? record(groups[groupIndex]) : undefined;
        const memberIds = strings(group?.member_block_ids) ?? [];
        if (!group || group.decision !== "review" || candidate.replacementMode === "none" || memberIds.some((id) => claimed.has(id))) {
          diagnostics.push({ level: "warning", code: "mineru-user-review-accept-abstained", message: `候选 ${candidate.id} 缺少可验证替换方式，未应用接受操作。` });
          visibleDecision = { ...decision, verdict: "abstain" };
        } else {
          try {
            const verified = validateCorrection(memberIds, candidate, parsed.blocks, input.visualRepair, claimed, input.sourcePdfPath, true);
            verified.reason_codes = ["explicit_user_accept", "runtime_geometry_revalidated"];
            groups.splice(groupIndex, 1, verified);
            applied += 1;
          } catch (error) {
            visibleDecision = { ...decision, verdict: "abstain" };
            diagnostics.push({
              level: "warning",
              code: "mineru-user-review-accept-abstained",
              message: `候选 ${candidate.id} 的碎图组合未通过重新检测：${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
      }
      if (decision.verdict === "accept" && candidate.kind === "cross_page_caption") {
        const currentWithoutCandidate = captionLinks.filter((link) => !captionLinkMatchesCandidate(record(link) ?? {}, candidate));
        try {
          const verified = validateCaptionCorrection(
            candidate.visualBlockId ?? "",
            candidate.captionBlockIds ?? [],
            candidate,
            parsed.blocks,
            currentWithoutCandidate,
            true
          );
          captionLinks = [...currentWithoutCandidate, verified];
          applied += 1;
        } catch (error) {
          visibleDecision = { ...decision, verdict: "abstain" };
          diagnostics.push({
            level: "warning",
            code: "mineru-user-review-accept-abstained",
            message: `候选 ${candidate.id} 的跨页图注关系未通过重新检测：${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
      if (decision.correction) {
        try {
          if (decision.correction.kind === "fragment_group") {
            groups.push(validateCorrection(decision.correction.member_block_ids, candidate, parsed.blocks, input.visualRepair, claimed, input.sourcePdfPath));
          } else {
            captionLinks.push(validateCaptionCorrection(
              decision.correction.visual_block_id,
              decision.correction.caption_block_ids,
              candidate,
              parsed.blocks,
              captionLinks
            ));
          }
          applied += 1;
        } catch (error) {
          visibleDecision = { ...decision, correction: null };
          diagnostics.push({
            level: "warning",
            code: "mineru-user-correction-rejected",
            message: `候选 ${candidate.id} 的替代修复未通过检测：${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
      visibleDecisions.push(visibleDecision);
    }
    cloned.groups = groups;
    cloned.caption_links = captionLinks;
    if (captionLinks.length < originalCaptionLinkCount) applied += originalCaptionLinkCount - captionLinks.length;
    const relevantPages = new Set<number>();
    parsed.candidates.forEach((candidate) => {
      relevantPages.add(candidate.pageIndex);
      if (candidate.targetPageIndex !== undefined) relevantPages.add(candidate.targetPageIndex);
    });
    const blocks = [...parsed.blocks.values()]
      .filter((block) => relevantPages.has(block.pageIndex) && (
        (block.role === "visual" && block.assetPath)
        || (["text", "title"].includes(block.role) && block.sourceText)
      ))
      .map((block) => ({
        id: block.id,
        pageIndex: block.pageIndex,
        pageOrder: block.pageOrder,
        role: block.role as "visual" | "text" | "title",
        bbox: normalizedBbox(block.bbox)!,
        assetPath: block.assetPath,
        text: block.sourceText?.slice(0, MAX_REVIEW_TEXT_CHARS),
        formalFigureKey: leadingFormalFigureKey(block)
      }))
      .sort((left, right) => left.pageIndex - right.pageIndex || left.pageOrder - right.pageOrder);
    diagnostics.push({
      level: "info",
      code: "mineru-visual-review-ready",
      message: parsed.candidates.length
        ? `已验证 ${parsed.candidates.length} 个视觉候选；${applied} 项用户决定通过检测并应用于当前显示。`
        : "视觉候选契约有效；当前没有需要人工审阅的项目。"
    });
    const review: MinerUVisualReview = {
        packageHash,
        storageKey: visualReviewStorageKey(packageHash),
        candidates: parsed.candidates,
        blocks,
        decisions: visibleDecisions
    };
    const { sidecar: _sidecar, ...previewInput } = input;
    previewContexts.set(review, previewInput);
    return {
      review,
      visualRepair: cloned,
      diagnostics
    };
  } catch (error) {
    diagnostics.push({
      level: "warning",
      code: "mineru-visual-review-invalid",
      message: `视觉候选审阅不可用，已保留确定性修复：${error instanceof Error ? error.message : String(error)}`
    });
    return { visualRepair: input.visualRepair, diagnostics };
  }
}

export async function previewMinerUVisualReviewDecision(
  review: MinerUVisualReview,
  decision: MinerUVisualReviewDecision
): Promise<MinerUVisualReviewPreview> {
  const input = previewContexts.get(review);
  if (!input) throw new Error("视觉候选缺少当前源契约上下文，已拒绝预览");
  const decisions = new Map(review.decisions.map((item) => [item.candidate_id, item]));
  decisions.set(decision.candidate_id, decision);
  const sidecar = createVisualReviewSidecar(review.packageHash, [...decisions.values()]);
  if (visualReviewSidecarByteLength(sidecar) > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
    throw new Error("视觉修复预览超过 64 KiB 安全上限");
  }
  const prepared = await prepareMinerUVisualReview({ ...input, sidecar });
  const validatedDecision = prepared.review?.decisions.find((item) => item.candidate_id === decision.candidate_id);
  const valid = Boolean(validatedDecision && canonicalJson(validatedDecision) === canonicalJson(decision));
  const candidate = review.candidates.find((item) => item.id === decision.candidate_id);
  const effect: MinerUVisualReviewPreview["effect"] = !valid || !candidate
    ? "invalid"
    : decision.verdict === "abstain"
      ? "leave-unchanged"
      : decision.verdict === "reject" && !decision.correction
        ? "reject-candidate"
        : (decision.correction?.kind ?? candidate.kind) === "fragment_group"
          ? "merge-fragments"
          : "link-caption";
  return {
    valid,
    writesSidecar: false,
    candidateId: decision.candidate_id,
    effect,
    requestedDecision: structuredClone(decision),
    validatedDecision: validatedDecision ? structuredClone(validatedDecision) : undefined,
    diagnostics: prepared.diagnostics.map((item) => ({ ...item }))
  };
}
