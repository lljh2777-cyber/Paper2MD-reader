import {
  AnchorInventory,
  BLOCK_FINGERPRINT_VERSION,
  Diagnostic,
  MARKDOWN_ANCHOR_CONTRACT_VERSION,
  PackageState,
  RawReaderContract,
  ReaderAsset,
  ReaderAssetKind,
  ReaderBlock,
  ReaderBlockKind,
  ReaderContract,
  ReaderRelation,
  ReaderRelationType,
  READER_CONTRACT_VERSION,
  SourceSpan
} from "./reader-contract";
import { PACKAGE_LIMITS } from "./package-limits";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const BLOCK_ID = /^blk_[0-9a-f]{24}$/;
const SLOT_ID = /^slot_[0-9a-f]{24}$/;
const ASSET_ID = /^ast_[0-9a-f]{24}$/;
const RELATION_ID = /^rel_[0-9a-f]{24}$/;
const BLOCK_MARKER = /^<!-- p2md:block id="(blk_[0-9a-f]{24})" kind="([a-z_]+)" -->$/;
const SLOT_MARKER = /^<!-- p2md:slot id="(slot_[0-9a-f]{24})" asset="(ast_[0-9a-f]{24})" -->$/;

const BLOCK_KINDS = new Set<ReaderBlockKind>([
  "title",
  "heading",
  "body",
  "caption",
  "footnote",
  "visual_slot",
  "unknown"
]);
const ASSET_KINDS = new Set<ReaderAssetKind>(["figure", "table", "equation", "unknown"]);
const RELATION_TYPES = new Set<ReaderRelationType>(["places", "caption-of"]);

export interface ContractParseResult {
  contract?: ReaderContract;
  contractVersion?: string;
  diagnostics: Diagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function error(diagnostics: Diagnostic[], code: string, message: string): void {
  diagnostics.push({ level: "error", code, message });
}

function validateSourceSpans(value: unknown, diagnostics: Diagnostic[], context: string, requireOne: boolean): void {
  if (!Array.isArray(value) || (requireOne && value.length === 0)) {
    error(diagnostics, "invalid-source-spans", `${context}.source_spans 必须是${requireOne ? "非空" : ""}数组。`);
    return;
  }

  value.forEach((span, index) => {
    const label = `${context}.source_spans[${index}]`;
    if (!isRecord(span) || !hasExactKeys(span, ["page_index", "bbox", "region_id", "paragraph_index", "elements_sha256"])) {
      error(diagnostics, "invalid-source-span", `${label} 字段不符合 Reader v0.1。`);
      return;
    }
    if (!isInteger(span.page_index)) error(diagnostics, "invalid-source-page", `${label}.page_index 非法。`);
    if (span.region_id !== null && !stringValue(span.region_id)) {
      error(diagnostics, "invalid-source-region", `${label}.region_id 非法。`);
    }
    if (span.paragraph_index !== null && !isInteger(span.paragraph_index)) {
      error(diagnostics, "invalid-source-paragraph", `${label}.paragraph_index 非法。`);
    }
    if (typeof span.elements_sha256 !== "string" || !HEX_64.test(span.elements_sha256)) {
      error(diagnostics, "invalid-source-hash", `${label}.elements_sha256 非法。`);
    }
    if (!isRecord(span.bbox) || !hasExactKeys(span.bbox, ["x", "y", "width", "height"])) {
      error(diagnostics, "invalid-source-bbox", `${label}.bbox 字段非法。`);
      return;
    }
    const { x, y, width, height } = span.bbox;
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      !isFiniteNumber(width) ||
      !isFiniteNumber(height) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1.00000001 ||
      y + height > 1.00000001
    ) {
      error(diagnostics, "invalid-source-bbox", `${label}.bbox 越界或不是有限归一化坐标。`);
    }
  });
}

function validateArticle(value: unknown, diagnostics: Diagnostic[]): void {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "sha256", "anchor_contract", "block_fingerprint_version"])) {
    error(diagnostics, "invalid-article", "reader.json.article 字段不符合 Reader v0.1。");
    return;
  }
  if (value.path !== "article.md") error(diagnostics, "invalid-article-path", "Reader v0.1 的 article.path 必须是 article.md。");
  if (typeof value.sha256 !== "string" || !HEX_64.test(value.sha256)) {
    error(diagnostics, "invalid-article-hash", "reader.json.article.sha256 非法。");
  }
  if (value.anchor_contract !== MARKDOWN_ANCHOR_CONTRACT_VERSION) {
    error(diagnostics, "unsupported-anchor-contract", `不支持 Markdown anchor 契约：${String(value.anchor_contract)}。`);
  }
  if (value.block_fingerprint_version !== BLOCK_FINGERPRINT_VERSION) {
    error(diagnostics, "unsupported-fingerprint-contract", `不支持 block fingerprint 契约：${String(value.block_fingerprint_version)}。`);
  }
}

function validateCapabilities(value: unknown, diagnostics: Diagnostic[]): void {
  if (!isRecord(value) || !hasExactKeys(value, ["layout_semantics", "caption_binding", "body_references"])) {
    error(diagnostics, "invalid-capabilities", "reader.json.capabilities 字段不符合 Reader v0.1。");
    return;
  }
  if (
    value.layout_semantics !== "reviewed" ||
    value.caption_binding !== "reviewed-layout-geometry" ||
    value.body_references !== "unavailable"
  ) {
    error(diagnostics, "invalid-capabilities", "Reader v0.1 capabilities 内容非法。");
  }
}

function validateBlocks(value: unknown, diagnostics: Diagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    error(diagnostics, "invalid-blocks", "reader.json.blocks 必须是非空数组。");
    return;
  }

  value.forEach((block, index) => {
    const context = `blocks[${index}]`;
    if (!isRecord(block) || !hasExactKeys(block, ["id", "kind", "order", "anchor", "fingerprint", "source_spans", "asset_id"])) {
      error(diagnostics, "invalid-block", `${context} 字段不符合 Reader v0.1。`);
      return;
    }
    const kind = stringValue(block.kind);
    if (!kind || !BLOCK_KINDS.has(kind as ReaderBlockKind)) {
      error(diagnostics, "invalid-block-kind", `${context}.kind 非法。`);
    }
    const expectedIdPattern = kind === "visual_slot" ? SLOT_ID : BLOCK_ID;
    if (typeof block.id !== "string" || !expectedIdPattern.test(block.id)) {
      error(diagnostics, "invalid-block-id", `${context}.id 与 kind 不一致。`);
    }
    if (block.order !== index + 1) {
      error(diagnostics, "invalid-block-order", `${context}.order 必须按数组顺序从 1 连续递增。`);
    }

    const expectedSyntax = kind === "visual_slot" ? "p2md:slot" : "p2md:block";
    if (
      !isRecord(block.anchor) ||
      !hasExactKeys(block.anchor, ["syntax", "id"]) ||
      block.anchor.syntax !== expectedSyntax ||
      block.anchor.id !== block.id
    ) {
      error(diagnostics, "invalid-block-anchor", `${context}.anchor 与 block 身份不一致。`);
    }

    if (!isRecord(block.fingerprint) || !hasExactKeys(block.fingerprint, ["visible_text_sha256", "simhash64", "text_length"])) {
      error(diagnostics, "invalid-block-fingerprint", `${context}.fingerprint 字段非法。`);
    } else if (
      typeof block.fingerprint.visible_text_sha256 !== "string" ||
      !HEX_64.test(block.fingerprint.visible_text_sha256) ||
      typeof block.fingerprint.simhash64 !== "string" ||
      !HEX_16.test(block.fingerprint.simhash64) ||
      !isInteger(block.fingerprint.text_length)
    ) {
      error(diagnostics, "invalid-block-fingerprint", `${context}.fingerprint 内容非法。`);
    }

    validateSourceSpans(block.source_spans, diagnostics, context, kind !== "title");
    if (kind === "visual_slot") {
      if (typeof block.asset_id !== "string" || !ASSET_ID.test(block.asset_id)) {
        error(diagnostics, "invalid-slot-asset", `${context}.asset_id 非法。`);
      }
    } else if (block.asset_id !== null) {
      error(diagnostics, "invalid-block-asset", `${context} 不是 visual_slot，不允许 asset_id。`);
    }
  });

  const titleCount = value.filter((block) => isRecord(block) && block.kind === "title").length;
  if (!isRecord(value[0]) || value[0].kind !== "title" || titleCount !== 1) {
    error(diagnostics, "invalid-title-block", "reader.json.blocks 必须以唯一 title block 开始。");
  }
}

function validateAssets(value: unknown, diagnostics: Diagnostic[]): void {
  if (!Array.isArray(value)) {
    error(diagnostics, "invalid-assets", "reader.json.assets 必须是数组。");
    return;
  }
  if (value.length > PACKAGE_LIMITS.assetCount) {
    error(diagnostics, "too-many-assets", `reader.json.assets exceeds the safe limit of ${PACKAGE_LIMITS.assetCount}.`);
    return;
  }

  let declaredAssetBytes = 0;
  value.forEach((asset, index) => {
    const context = `assets[${index}]`;
    if (!isRecord(asset) || !hasExactKeys(asset, [
      "id",
      "kind",
      "path",
      "sha256",
      "size_bytes",
      "width_px",
      "height_px",
      "display_label",
      "caption_block_id",
      "placement_block_id",
      "source_spans"
    ])) {
      error(diagnostics, "invalid-asset", `${context} 字段不符合 Reader v0.1。`);
      return;
    }
    if (typeof asset.id !== "string" || !ASSET_ID.test(asset.id)) error(diagnostics, "invalid-asset-id", `${context}.id 非法。`);
    if (typeof asset.kind !== "string" || !ASSET_KINDS.has(asset.kind as ReaderAssetKind)) {
      error(diagnostics, "invalid-asset-kind", `${context}.kind 非法。`);
    }
    if (typeof asset.path !== "string" || !/^images\/[^/]+\.png$/.test(asset.path) || !isSafeRelativePath(asset.path)) {
      error(diagnostics, "invalid-asset-path", `${context}.path 必须是安全的 images/*.png 路径。`);
    }
    if (typeof asset.sha256 !== "string" || !HEX_64.test(asset.sha256)) error(diagnostics, "invalid-asset-hash", `${context}.sha256 非法。`);
    if (isInteger(asset.size_bytes, 1)) {
      declaredAssetBytes += asset.size_bytes;
      if (asset.size_bytes > PACKAGE_LIMITS.assetBytes) {
        error(diagnostics, "asset-too-large", `${context}.size_bytes exceeds the safe limit of ${PACKAGE_LIMITS.assetBytes}.`);
      }
    }
    if (!isInteger(asset.size_bytes, 1) || !isInteger(asset.width_px, 1) || !isInteger(asset.height_px, 1)) {
      error(diagnostics, "invalid-asset-metadata", `${context} 的大小或像素尺寸非法。`);
    }
    if (asset.display_label !== null && !stringValue(asset.display_label)) {
      error(diagnostics, "invalid-display-label", `${context}.display_label 非法。`);
    }
    if (asset.caption_block_id !== null && (typeof asset.caption_block_id !== "string" || !BLOCK_ID.test(asset.caption_block_id))) {
      error(diagnostics, "invalid-caption-block", `${context}.caption_block_id 非法。`);
    }
    if (typeof asset.placement_block_id !== "string" || !SLOT_ID.test(asset.placement_block_id)) {
      error(diagnostics, "invalid-placement-block", `${context}.placement_block_id 非法。`);
    }
    validateSourceSpans(asset.source_spans, diagnostics, context, true);
  });
  if (declaredAssetBytes > PACKAGE_LIMITS.totalAssetBytes) {
    error(diagnostics, "asset-total-too-large", `reader.json.assets declares ${declaredAssetBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`);
  }
}

function validateRelations(value: unknown, diagnostics: Diagnostic[]): void {
  if (!Array.isArray(value)) {
    error(diagnostics, "invalid-relations", "reader.json.relations 必须是数组。");
    return;
  }

  value.forEach((relation, index) => {
    const context = `relations[${index}]`;
    if (!isRecord(relation) || !hasExactKeys(relation, ["id", "type", "source_id", "target_id", "label"])) {
      error(diagnostics, "invalid-relation", `${context} 字段不符合 Reader v0.1。`);
      return;
    }
    if (typeof relation.id !== "string" || !RELATION_ID.test(relation.id)) error(diagnostics, "invalid-relation-id", `${context}.id 非法。`);
    if (typeof relation.type !== "string" || !RELATION_TYPES.has(relation.type as ReaderRelationType)) {
      error(diagnostics, "invalid-relation-type", `${context}.type 非法。`);
    }
    if (typeof relation.source_id !== "string" || !/^(?:blk|slot)_[0-9a-f]{24}$/.test(relation.source_id)) {
      error(diagnostics, "invalid-relation-source", `${context}.source_id 非法。`);
    }
    if (typeof relation.target_id !== "string" || !ASSET_ID.test(relation.target_id)) {
      error(diagnostics, "invalid-relation-target", `${context}.target_id 非法。`);
    }
    if (relation.label !== null && !stringValue(relation.label)) error(diagnostics, "invalid-relation-label", `${context}.label 非法。`);
  });
}

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function validateContractGraph(contract: ReaderContract, diagnostics: Diagnostic[]): void {
  const blockDuplicates = duplicateValues(contract.blocks.map((block) => block.id));
  const assetDuplicates = duplicateValues(contract.assets.map((asset) => asset.id));
  const relationDuplicates = duplicateValues(contract.relations.map((relation) => relation.id));
  if (blockDuplicates.length || assetDuplicates.length || relationDuplicates.length) {
    error(diagnostics, "duplicate-contract-id", `契约 ID 重复：${[...blockDuplicates, ...assetDuplicates, ...relationDuplicates].join(", ")}。`);
  }

  const blockById = new Map(contract.blocks.map((block) => [block.id, block]));
  const assetById = new Map(contract.assets.map((asset) => [asset.id, asset]));
  const relationKeys = new Set<string>();
  const captionOwners = new Set<string>();

  for (const block of contract.blocks) {
    if (block.kind === "visual_slot" && !assetById.has(block.asset_id ?? "")) {
      error(diagnostics, "slot-asset-missing", `visual slot ${block.id} 指向不存在的 asset ${block.asset_id}。`);
    }
  }

  for (const asset of contract.assets) {
    const placement = blockById.get(asset.placement_block_id);
    if (!placement || placement.kind !== "visual_slot" || placement.asset_id !== asset.id) {
      error(diagnostics, "invalid-asset-placement", `asset ${asset.id} 的 placement_block_id 与 visual slot 不一致。`);
    }
    if (asset.caption_block_id) {
      const caption = blockById.get(asset.caption_block_id);
      if (!caption || caption.kind !== "caption") {
        error(diagnostics, "invalid-asset-caption", `asset ${asset.id} 的 caption_block_id 不是 caption block。`);
      }
      if (captionOwners.has(asset.caption_block_id)) {
        error(diagnostics, "caption-reused", `caption block ${asset.caption_block_id} 被多个 asset 复用。`);
      }
      captionOwners.add(asset.caption_block_id);
    }
  }

  for (const relation of contract.relations) {
    const key = `${relation.type}\0${relation.source_id}\0${relation.target_id}`;
    if (relationKeys.has(key)) error(diagnostics, "duplicate-relation", `关系重复：${relation.type} ${relation.source_id} → ${relation.target_id}。`);
    relationKeys.add(key);

    const source = blockById.get(relation.source_id);
    const target = assetById.get(relation.target_id);
    if (!source) error(diagnostics, "dangling-relation-source", `关系来源不存在：${relation.source_id}。`);
    if (!target) error(diagnostics, "dangling-relation-target", `关系目标不存在：${relation.target_id}。`);
    if (!source || !target) continue;

    if (relation.type === "places" && (
      source.kind !== "visual_slot" ||
      source.asset_id !== target.id ||
      target.placement_block_id !== source.id ||
      relation.label !== null
    )) {
      error(diagnostics, "invalid-places-relation", `places 关系与 slot/asset 身份不一致：${relation.id}。`);
    }
    if (relation.type === "caption-of" && (
      source.kind !== "caption" ||
      target.caption_block_id !== source.id ||
      relation.label !== target.display_label
    )) {
      error(diagnostics, "invalid-caption-relation", `caption-of 关系与 caption/asset 身份不一致：${relation.id}。`);
    }
  }

  for (const asset of contract.assets) {
    if (!relationKeys.has(`places\0${asset.placement_block_id}\0${asset.id}`)) {
      error(diagnostics, "missing-places-relation", `asset ${asset.id} 缺少 places 关系。`);
    }
    if (asset.caption_block_id && !relationKeys.has(`caption-of\0${asset.caption_block_id}\0${asset.id}`)) {
      error(diagnostics, "missing-caption-relation", `asset ${asset.id} 缺少 caption-of 关系。`);
    }
  }
}

export function parseAnchorInventory(markdown: string): AnchorInventory {
  const allIds: string[] = [];
  const blockIds: string[] = [];
  const slotIds: string[] = [];
  const malformedMarkers: string[] = [];
  const blockKinds = new Map<string, string>();
  const slotAssets = new Map<string, string>();

  markdown.split(/\r?\n/).forEach((line, index) => {
    const block = BLOCK_MARKER.exec(line);
    if (block) {
      blockIds.push(block[1]);
      allIds.push(block[1]);
      blockKinds.set(block[1], block[2]);
      return;
    }
    const slot = SLOT_MARKER.exec(line);
    if (slot) {
      slotIds.push(slot[1]);
      allIds.push(slot[1]);
      slotAssets.set(slot[1], slot[2]);
      return;
    }
    if (line.includes("<!-- p2md:block") || line.includes("<!-- p2md:slot")) {
      malformedMarkers.push(`line ${index + 1}`);
    }
  });

  return {
    blockIds,
    slotIds,
    duplicateIds: duplicateValues(allIds),
    malformedMarkers,
    blockKinds,
    slotAssets
  };
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || /^[a-zA-Z]:/.test(path) || path.startsWith("/")) return false;
  const segments = path.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

export function normalizeContract(raw: RawReaderContract): ContractParseResult {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(raw)) {
    error(diagnostics, "invalid-contract-root", "reader.json 顶层必须是对象。");
    return { diagnostics };
  }

  const contractVersion = stringValue(raw.contract_version);
  if (!contractVersion) {
    error(diagnostics, "missing-version", "reader.json 缺少 contract_version。");
    return { diagnostics };
  }
  if (!supportsContractVersion(contractVersion)) return { contractVersion, diagnostics };

  if (!hasExactKeys(raw, ["contract_version", "source_sha256", "article", "capabilities", "blocks", "assets", "relations"])) {
    error(diagnostics, "invalid-top-level-fields", "reader.json 顶层字段不符合 Reader v0.1。");
  }
  if (typeof raw.source_sha256 !== "string" || !HEX_64.test(raw.source_sha256)) {
    error(diagnostics, "invalid-source-hash", "reader.json.source_sha256 非法。");
  }

  validateArticle(raw.article, diagnostics);
  validateCapabilities(raw.capabilities, diagnostics);
  validateBlocks(raw.blocks, diagnostics);
  validateAssets(raw.assets, diagnostics);
  validateRelations(raw.relations, diagnostics);

  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return { contractVersion, diagnostics };
  }

  const contract = raw as unknown as ReaderContract;
  validateContractGraph(contract, diagnostics);
  return diagnostics.some((diagnostic) => diagnostic.level === "error")
    ? { contractVersion, diagnostics }
    : { contractVersion, contract, diagnostics };
}

export function supportsContractVersion(version: string): boolean {
  return version === READER_CONTRACT_VERSION;
}

export function expectedAnchorIds(contract: ReaderContract): { blocks: Set<string>; slots: Set<string> } {
  return {
    blocks: new Set(contract.blocks.filter((block) => block.kind !== "visual_slot").map((block) => block.id)),
    slots: new Set(contract.blocks.filter((block) => block.kind === "visual_slot").map((block) => block.id))
  };
}

export function derivePackageState(
  contract: ReaderContract,
  diagnostics: Diagnostic[],
  articleHash: string,
  anchors: AnchorInventory
): PackageState {
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) return "invalid-contract";

  if (anchors.duplicateIds.length || anchors.malformedMarkers.length) {
    diagnostics.push({
      level: "warning",
      code: "ambiguous-anchors",
      message: `Markdown 含 ${anchors.duplicateIds.length} 个重复锚点和 ${anchors.malformedMarkers.length} 个格式非法的 p2md marker。`
    });
    return "ambiguous";
  }

  const expected = expectedAnchorIds(contract);
  const actualBlocks = new Set(anchors.blockIds);
  const actualSlots = new Set(anchors.slotIds);
  const missingBlocks = [...expected.blocks].filter((id) => !actualBlocks.has(id));
  const missingSlots = [...expected.slots].filter((id) => !actualSlots.has(id));
  const unexpectedBlocks = [...actualBlocks].filter((id) => !expected.blocks.has(id));
  const unexpectedSlots = [...actualSlots].filter((id) => !expected.slots.has(id));

  const metadataMismatches: string[] = [];
  for (const block of contract.blocks) {
    if (block.kind === "visual_slot") {
      if (actualSlots.has(block.id) && anchors.slotAssets.get(block.id) !== block.asset_id) {
        metadataMismatches.push(block.id);
      }
    } else if (actualBlocks.has(block.id) && anchors.blockKinds.get(block.id) !== block.kind) {
      metadataMismatches.push(block.id);
    }
  }

  if (unexpectedBlocks.length || unexpectedSlots.length || metadataMismatches.length) {
    diagnostics.push({
      level: "warning",
      code: "anchor-identity-mismatch",
      message: `Markdown 含额外锚点或锚点元数据不一致（额外 block ${unexpectedBlocks.length}，额外 slot ${unexpectedSlots.length}，身份冲突 ${metadataMismatches.length}）。`
    });
    return "ambiguous";
  }

  if (missingBlocks.length || missingSlots.length) {
    diagnostics.push({
      level: "warning",
      code: "missing-anchors",
      message: `正文缺少 ${missingBlocks.length} 个 block 锚点和 ${missingSlots.length} 个 slot 锚点；Reader 不会猜测结构。`
    });
    return "recoverable";
  }

  if (contract.article.sha256.toLowerCase() !== articleHash.toLowerCase()) {
    diagnostics.push({ level: "warning", code: "article-edited", message: "article.md 已编辑，但公共锚点仍完整。" });
    return "edited-with-anchors";
  }
  return "valid";
}
