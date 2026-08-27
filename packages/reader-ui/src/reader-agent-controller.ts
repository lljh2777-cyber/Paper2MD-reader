import type {
  MinerUVisualReviewDecision,
  MinerUVisualReviewPreview
} from "../../../src/model/mineru-visual-review";
import type { PackageState } from "../../../src/model/reader-contract";
import type { ReferenceMode } from "../../../src/render/reference-sidebar";

export type ReaderLifecycle = "idle" | "loading" | "ready" | "degraded" | "error";
export type ReaderFollowTarget = "visuals" | "pdf";

export interface ReaderAgentState {
  lifecycle: ReaderLifecycle;
  package?: {
    label: string;
    articleSha256?: string;
    sourceFormat?: "paper2md" | "mineru" | "markdown" | "html";
    packageState: PackageState;
    packageIntegrity?: "verified" | "unverified";
    contractVersion?: string;
  };
  headingCount: number;
  activeHeadingId?: string;
  visualCount: number;
  repairCandidateCount: number;
  reference: {
    available: boolean;
    mode: ReferenceMode;
    pdfAvailable: boolean;
    selectedVisualId: string;
    visualFollowing: boolean;
    pdfFollowing: boolean;
    pdfPage: number;
  };
}

export interface ReaderHeadingSummary {
  id: string;
  label: string;
  level: number;
  active: boolean;
}

export interface ReaderAgentPage<T> {
  items: T[];
  total: number;
  start: number;
  nextStart?: number;
}

export interface ReaderVisualSummary {
  id: string;
  label: string;
  kind: string;
  available: boolean;
  selected: boolean;
  hasArticleAnchor: boolean;
  page?: number;
  captionPage?: number;
  captionStatus?: "complete" | "partial";
  captionText?: string;
}

export interface ReaderVisualRepairBlockSummary {
  id: string;
  page: number;
  order: number;
  role: "visual" | "text" | "title";
  bbox: { x: number; y: number; width: number; height: number };
  text?: string;
  formalFigureKey?: string;
}

export interface ReaderVisualRepairCandidateSummary {
  id: string;
  kind: "fragment_group" | "cross_page_caption";
  page: number;
  targetPage?: number;
  memberBlockIds: string[];
  replacementMode?: "pdf_crop" | "existing_asset" | "none";
  figureKey?: string;
  visualBlockId?: string;
  captionBlockIds?: string[];
  decision?: MinerUVisualReviewDecision;
  blockCount: number;
  blocksTruncated: boolean;
  blocks: ReaderVisualRepairBlockSummary[];
}

/** A narrow, host-neutral command surface. It never exposes DOM nodes, paths, source files, or write primitives. */
export interface ReaderAgentController {
  getReaderState(): ReaderAgentState;
  listHeadings(start?: number, limit?: number): ReaderAgentPage<ReaderHeadingSummary>;
  listVisuals(start?: number, limit?: number): ReaderAgentPage<ReaderVisualSummary>;
  navigateToHeading(id: string): ReaderHeadingSummary;
  navigateToVisual(id: string): ReaderVisualSummary;
  setReferenceMode(mode: ReferenceMode): ReaderAgentState["reference"];
  setFollowMode(target: ReaderFollowTarget, enabled: boolean): ReaderAgentState["reference"];
  getVisualRepairCandidates(start?: number, limit?: number): ReaderAgentPage<ReaderVisualRepairCandidateSummary>;
  previewVisualCorrection(decision: MinerUVisualReviewDecision): Promise<MinerUVisualReviewPreview>;
}
