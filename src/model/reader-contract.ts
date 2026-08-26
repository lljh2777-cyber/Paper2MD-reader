export const READER_CONTRACT_VERSION = "paper2md-reader-v0.1";
export const MARKDOWN_ANCHOR_CONTRACT_VERSION = "paper2md-markdown-anchor-v0.1";
export const BLOCK_FINGERPRINT_VERSION = "paper2md-visible-block-fingerprint-v0.1";
export const READER_BOUND_MANIFEST_VERSIONS = [
  "paper2md-manifest-v0.8",
  "paper2md-manifest-v0.9",
  "paper2md-manifest-v0.10"
] as const;
export type ReaderBoundManifestVersion = typeof READER_BOUND_MANIFEST_VERSIONS[number];
export const HYBRID_MANIFEST_VERSION: ReaderBoundManifestVersion = "paper2md-manifest-v0.9";

export type PackageState =
  | "valid"
  | "edited-with-anchors"
  | "recoverable"
  | "mineru"
  | "markdown"
  | "ambiguous"
  | "reader-missing"
  | "unsupported-version"
  | "invalid-contract";

export type ReaderBlockKind =
  | "title"
  | "heading"
  | "body"
  | "caption"
  | "footnote"
  | "visual_slot"
  | "unknown";

export type ReaderAssetKind = "figure" | "table" | "equation" | "unknown";
export type ReaderRelationType = "caption-of" | "places";

export interface NormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceSpan {
  page_index: number;
  bbox: NormalizedBBox;
  region_id: string | null;
  paragraph_index: number | null;
  elements_sha256: string;
}

export interface ArticleDescriptor {
  path: "article.md";
  sha256: string;
  anchor_contract: typeof MARKDOWN_ANCHOR_CONTRACT_VERSION;
  block_fingerprint_version: typeof BLOCK_FINGERPRINT_VERSION;
}

export interface ReaderAnchor {
  syntax: "p2md:block" | "p2md:slot";
  id: string;
}

export interface BlockFingerprint {
  visible_text_sha256: string;
  simhash64: string;
  text_length: number;
}

export interface ReaderBlock {
  id: string;
  kind: ReaderBlockKind;
  order: number;
  anchor: ReaderAnchor;
  fingerprint: BlockFingerprint;
  source_spans: SourceSpan[];
  asset_id: string | null;
}

export interface ReaderAsset {
  id: string;
  kind: ReaderAssetKind;
  path: string;
  sha256: string;
  size_bytes: number;
  width_px: number;
  height_px: number;
  display_label: string | null;
  caption_block_id: string | null;
  placement_block_id: string;
  source_spans: SourceSpan[];
}

export interface ReaderRelation {
  id: string;
  type: ReaderRelationType;
  source_id: string;
  target_id: string;
  label: string | null;
}

export interface ReaderCapabilities {
  layout_semantics: "reviewed";
  caption_binding: "reviewed-layout-geometry";
  body_references: "unavailable";
}

export interface ReaderContract {
  contract_version: typeof READER_CONTRACT_VERSION;
  source_sha256: string;
  article: ArticleDescriptor;
  capabilities: ReaderCapabilities;
  blocks: ReaderBlock[];
  assets: ReaderAsset[];
  relations: ReaderRelation[];
}

export interface AnchorInventory {
  blockIds: string[];
  slotIds: string[];
  duplicateIds: string[];
  malformedMarkers: string[];
  blockKinds: Map<string, string>;
  slotAssets: Map<string, string>;
}

export interface Diagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface LoadedAsset {
  id: string;
  kind: ReaderAssetKind;
  path: string;
  display_label: string | null;
  caption_block_id: string | null;
  placement_block_id: string | null;
  sha256?: string;
  size_bytes?: number;
  width_px?: number;
  height_px?: number;
  source_spans?: SourceSpan[];
  vaultPath: string;
  exists: boolean;
  integrityMatches?: boolean;
  captionText?: string;
  pageIndex?: number;
  sourceBBox?: NormalizedBBox;
  memberAssetPaths?: string[];
  captionPageIndex?: number;
  captionStatus?: "complete" | "partial";
  display?:
    | { mode: "asset" }
    | { mode: "pdf-crop"; pdfPath: string; bbox: NormalizedBBox; padding: number }
    | { mode: "fragment-set"; assetPaths: string[] };
}

export interface LoadedPaperPackage {
  state: PackageState;
  articlePath: string;
  articleText: string;
  articleHash?: string;
  contractPath?: string;
  contractVersion?: string;
  manifestPath?: string;
  contract?: ReaderContract;
  anchors: AnchorInventory;
  assets: LoadedAsset[];
  diagnostics: Diagnostic[];
  sourceFormat?: "paper2md" | "mineru" | "markdown";
  sourcePdf?: {
    path: string;
  };
  pageMap?: import("./mineru-page-map").MinerUPageMap;
  textRecovery?: {
    pdfPath: string;
    candidates: import("./mineru-text-recovery").MinerUTextRecoveryCandidate[];
    sourceArticleText?: string;
    captionContinuations?: import("./mineru-caption-recovery").PdfCaptionContinuationRequest[];
  };
}

export type RawReaderContract = unknown;

export function assetDisplayLabel(asset: Pick<ReaderAsset, "display_label" | "path" | "id">): string {
  if (asset.display_label) return asset.display_label;
  const filename = asset.path.split("/").pop()?.replace(/\.[^.]+$/, "");
  return filename || asset.id;
}
