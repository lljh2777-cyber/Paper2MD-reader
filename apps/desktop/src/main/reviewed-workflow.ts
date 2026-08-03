import { basename, extname, join } from "node:path";
import {
  EvidenceLevel,
  ExtractionProfile,
  LayoutReviewMode,
  ReferencePolicy
} from "../shared/desktop-api";

export interface ReviewedLayoutOptions {
  backend: "pdfium";
  extractionProfile: ExtractionProfile;
  reviewMode: LayoutReviewMode;
  references: ReferencePolicy;
  evidence: EvidenceLevel;
  includeSourcePdf: boolean;
}

export interface ReviewedWorkflowPaths {
  workspacePath: string;
  roiProposalPath: string;
  confirmedRoiPath: string;
  layoutReviewPath: string;
  outputPath: string;
  outputName: string;
}

interface RoiPage {
  page_index: number;
  content_bbox: { x: number; y: number; width: number; height: number };
}

interface RoiDocument {
  contract_version: string;
  source_sha256: string;
  review_status: string;
  reviewer: unknown;
  pages: RoiPage[];
}

export function safePaperStem(pdfPath: string): string {
  return basename(pdfPath, extname(pdfPath))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "paper";
}

export function reviewedWorkflowPaths(pdfPath: string, outputParent: string): ReviewedWorkflowPaths {
  const stem = safePaperStem(pdfPath);
  const workspacePath = join(outputParent, `${stem}-paper2md-workflow`);
  return {
    workspacePath,
    roiProposalPath: join(workspacePath, "01-roi-proposal"),
    confirmedRoiPath: join(workspacePath, "confirmed-content-roi.json"),
    layoutReviewPath: join(workspacePath, "02-layout-review"),
    outputPath: join(workspacePath, "03-output"),
    outputName: `${stem}-paper2md-workflow/03-output`
  };
}

export function roiProposalArgs(
  pdfPath: string,
  paths: ReviewedWorkflowPaths,
  options: ReviewedLayoutOptions
): string[] {
  return [
    "layout-prepare",
    pdfPath,
    paths.roiProposalPath,
    "--backend",
    options.backend,
    "--extraction-profile",
    options.extractionProfile,
    "--review-mode",
    options.reviewMode
  ];
}

export function layoutPrepareArgs(
  pdfPath: string,
  paths: ReviewedWorkflowPaths,
  options: ReviewedLayoutOptions
): string[] {
  return [
    "layout-prepare",
    pdfPath,
    paths.layoutReviewPath,
    "--backend",
    options.backend,
    "--content-roi-json",
    paths.confirmedRoiPath,
    "--extraction-profile",
    options.extractionProfile,
    "--review-mode",
    options.reviewMode
  ];
}

export function validateLayoutArgs(taskPath: string, finalLayoutPath: string): string[] {
  return ["validate-final-layout", finalLayoutPath, "--task", taskPath];
}

export function layoutApplyArgs(
  pdfPath: string,
  paths: ReviewedWorkflowPaths,
  options: ReviewedLayoutOptions
): string[] {
  const args = [
    "layout-apply",
    pdfPath,
    paths.layoutReviewPath,
    paths.outputPath,
    "--backend",
    options.backend,
    "--references",
    options.references,
    "--evidence",
    options.evidence,
    "--extraction-profile",
    options.extractionProfile
  ];
  if (options.includeSourcePdf) args.push("--include-source-pdf");
  return args;
}

function parseRoi(value: unknown, label: string): RoiDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.contract_version !== "string" || typeof candidate.source_sha256 !== "string") {
    throw new Error(`${label} is missing its contract or source hash`);
  }
  if (!Array.isArray(candidate.pages) || candidate.pages.length === 0) {
    throw new Error(`${label} must contain at least one page ROI`);
  }
  const pages = candidate.pages.map((page, index): RoiPage => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new Error(`${label} page ${index + 1} is invalid`);
    }
    const pageRecord = page as Record<string, unknown>;
    const bbox = pageRecord.content_bbox;
    if (!Number.isInteger(pageRecord.page_index) || !bbox || typeof bbox !== "object" || Array.isArray(bbox)) {
      throw new Error(`${label} page ${index + 1} has an invalid index or bounding box`);
    }
    const bboxRecord = bbox as Record<string, unknown>;
    const coordinates = [bboxRecord.x, bboxRecord.y, bboxRecord.width, bboxRecord.height].map(Number);
    if (coordinates.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0)) {
      throw new Error(`${label} page ${index + 1} coordinates must be normalized numbers`);
    }
    if (coordinates[2] <= 0 || coordinates[3] <= 0 || coordinates[0] + coordinates[2] > 1 + 1e-9 || coordinates[1] + coordinates[3] > 1 + 1e-9) {
      throw new Error(`${label} page ${index + 1} bounding box has no area`);
    }
    return {
      page_index: pageRecord.page_index as number,
      content_bbox: {
        x: coordinates[0],
        y: coordinates[1],
        width: coordinates[2],
        height: coordinates[3]
      }
    };
  });
  return {
    contract_version: candidate.contract_version,
    source_sha256: candidate.source_sha256,
    review_status: String(candidate.review_status ?? ""),
    reviewer: candidate.reviewer,
    pages
  };
}

export function validateConfirmedRoi(proposalValue: unknown, reviewedValue: unknown): void {
  const proposal = parseRoi(proposalValue, "Generated ROI proposal");
  const reviewed = parseRoi(reviewedValue, "Reviewed ROI");
  if (reviewed.contract_version !== proposal.contract_version || reviewed.source_sha256 !== proposal.source_sha256) {
    throw new Error("Reviewed ROI does not belong to this PDF proposal");
  }
  if (reviewed.review_status !== "confirmed" || typeof reviewed.reviewer !== "string" || !reviewed.reviewer.trim()) {
    throw new Error("Reviewed ROI must be confirmed and name a reviewer");
  }
  const proposalPages = new Set(proposal.pages.map((page) => page.page_index));
  const reviewedPages = new Set(reviewed.pages.map((page) => page.page_index));
  if (
    proposalPages.size !== proposal.pages.length ||
    reviewedPages.size !== reviewed.pages.length ||
    reviewedPages.size !== proposalPages.size ||
    [...proposalPages].some((pageIndex) => !reviewedPages.has(pageIndex))
  ) {
    throw new Error("Reviewed ROI page count does not match the proposal");
  }
}
