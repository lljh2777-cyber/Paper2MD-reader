import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  layoutApplyArgs,
  layoutPrepareArgs,
  reviewedWorkflowPaths,
  roiProposalArgs,
  validateConfirmedRoi,
  validateLayoutArgs
} from "../apps/desktop/src/main/reviewed-workflow";

const options = {
  backend: "pdfium" as const,
  extractionProfile: "standard" as const,
  reviewMode: "visual-direct" as const,
  references: "keep" as const,
  evidence: "standard" as const,
  includeSourcePdf: true
};

function roi(reviewStatus: "proposed" | "confirmed", reviewer: string | null = null) {
  return {
    contract_version: "paper2md-content-roi-v0.1",
    source_sha256: "a".repeat(64),
    review_status: reviewStatus,
    reviewer,
    coordinate_system: "top-left/original-page-normalized/y-down",
    destructive_crop: false,
    pages: [
      { page_index: 0, content_bbox: { x: 0.05, y: 0.08, width: 0.9, height: 0.84 } },
      { page_index: 1, content_bbox: { x: 0.06, y: 0.09, width: 0.88, height: 0.82 } }
    ]
  };
}

describe("reviewed desktop workflow", () => {
  it("derives isolated non-overwriting stage paths", () => {
    const paths = reviewedWorkflowPaths("C:\\papers\\A paper.pdf", "D:\\exports");
    expect(paths.workspacePath).toBe(join("D:\\exports", "A-paper-paper2md-workflow"));
    expect(paths.roiProposalPath).toBe(join(paths.workspacePath, "01-roi-proposal"));
    expect(paths.layoutReviewPath).toBe(join(paths.workspacePath, "02-layout-review"));
    expect(paths.outputPath).toBe(join(paths.workspacePath, "03-output"));
  });

  it("builds only fixed Paper2MD subcommands and declared enum options", () => {
    const pdf = "C:\\papers\\paper.pdf";
    const paths = reviewedWorkflowPaths(pdf, "D:\\exports");
    expect(roiProposalArgs(pdf, paths, options)).toEqual([
      "layout-prepare", pdf, paths.roiProposalPath, "--backend", "pdfium",
      "--extraction-profile", "standard", "--review-mode", "visual-direct"
    ]);
    expect(layoutPrepareArgs(pdf, paths, options)).toContain(paths.confirmedRoiPath);
    expect(validateLayoutArgs("task.json", "final.json")).toEqual([
      "validate-final-layout", "final.json", "--task", "task.json"
    ]);
    expect(layoutApplyArgs(pdf, paths, options)).toEqual([
      "layout-apply", pdf, paths.layoutReviewPath, paths.outputPath,
      "--backend", "pdfium", "--references", "keep", "--evidence", "standard",
      "--extraction-profile", "standard", "--include-source-pdf"
    ]);
  });

  it("accepts a confirmed same-source ROI and allows reviewed geometry changes", () => {
    const proposal = roi("proposed");
    const reviewed = roi("confirmed", "visual-review-agent");
    reviewed.pages[0].content_bbox.width = 0.87;
    reviewed.pages.reverse();
    expect(() => validateConfirmedRoi(proposal, reviewed)).not.toThrow();
  });

  it("rejects unconfirmed, cross-source, malformed and page-mismatched ROI imports", () => {
    expect(() => validateConfirmedRoi(roi("proposed"), roi("proposed"))).toThrow("confirmed");

    const crossSource = roi("confirmed", "reviewer");
    crossSource.source_sha256 = "b".repeat(64);
    expect(() => validateConfirmedRoi(roi("proposed"), crossSource)).toThrow("does not belong");

    const overflow = roi("confirmed", "reviewer");
    overflow.pages[0].content_bbox.width = 1;
    expect(() => validateConfirmedRoi(roi("proposed"), overflow)).toThrow("bounding box");

    const missingPage = roi("confirmed", "reviewer");
    missingPage.pages.pop();
    expect(() => validateConfirmedRoi(roi("proposed"), missingPage)).toThrow("page count");
  });
});
