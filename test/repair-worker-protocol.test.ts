import { describe, expect, it } from "vitest";
import {
  REPAIR_WORKER_PROTOCOL,
  isRepairWorkerResponse,
  type RepairWorkerSuccessMessage
} from "../sites-reader/app/repair/repair-worker-protocol";

const REQUEST_ID = "repair-protocol-test";

function successResponse(): RepairWorkerSuccessMessage {
  return {
    protocol: REPAIR_WORKER_PROTOCOL,
    type: "success",
    requestId: REQUEST_ID,
    result: {
      algorithmVersion: "after-mineru-visual-repair-v1",
      outputs: {
        markdownZip: {
          status: "ready",
          bytes: new Uint8Array([80, 75, 3, 4, 1]).buffer,
          name: "paper.after-mineru-markdown.zip",
          fileCount: 3,
          representation: "source-assets-fallback",
          warnings: [{ code: "pdf-crop-not-materialized", count: 1 }]
        },
        verifiedPackage: {
          bytes: new Uint8Array([80, 75, 3, 4, 2]).buffer,
          name: "paper.after-mineru.zip",
          fileCount: 12
        }
      },
      report: {
        schema_version: 1,
        contract: "after-mineru-repair-report-v1",
        algorithm_version: "after-mineru-visual-repair-v1",
        status: "passed",
        source_archive_sha256: "a".repeat(64),
        derived_article_sha256: "b".repeat(64),
        source_pdf_included: false,
        checks: {
          source_archive_validated: true,
          source_tree_bound: true,
          derived_article_materialized: true,
          reader_projection_bound: true,
          compatibility_profile_generated: true
        },
        summary: {
          source_file_count: 4,
          source_image_count: 1,
          visible_visual_count: 1,
          repaired_visual_count: 1,
          review_candidate_count: 0,
          unresolved_text_replacement_count: 0
        },
        warnings: [{ code: "source-pdf-unavailable", count: 1 }]
      },
      sourceSha256: "a".repeat(64),
      summary: {
        sourceFileCount: 4,
        sourceImageCount: 1,
        visibleVisualCount: 1,
        repairedVisualCount: 1,
        reviewCandidateCount: 0,
        unresolvedTextReplacementCount: 0,
        sourcePdfIncluded: false
      }
    }
  };
}

function mutable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function expectInvalid(response: unknown): void {
  expect(isRepairWorkerResponse(response, REQUEST_ID)).toBe(false);
}

describe("Repair Worker v2 protocol guard", () => {
  it("accepts ready dual outputs and every supported unavailable reason", () => {
    expect(isRepairWorkerResponse(successResponse(), REQUEST_ID)).toBe(true);

    for (const reason of [
      "reader-slots-not-materialized",
      "unsupported-image-syntax",
      "unsafe-asset-reference",
      "missing-source-asset",
      "fallback-assets-incomplete",
      "portable-size-limit-exceeded",
      "portable-archive-validation-failed"
    ]) {
      const response = successResponse();
      mutable(response.result.outputs).markdownZip = { status: "unavailable", reason };
      expect(isRepairWorkerResponse(response, REQUEST_ID)).toBe(true);
    }
  });

  it("rejects a success response missing either output", () => {
    for (const key of ["markdownZip", "verifiedPackage"]) {
      const response = successResponse();
      delete mutable(response.result.outputs)[key];
      expectInvalid(response);
    }
  });

  it("rejects an empty buffer for either ready output", () => {
    for (const key of ["markdownZip", "verifiedPackage"] as const) {
      const response = successResponse();
      mutable(response.result.outputs[key]).bytes = new ArrayBuffer(0);
      expectInvalid(response);
    }
  });

  it("rejects unsafe or malformed ZIP filenames for either output", () => {
    for (const key of ["markdownZip", "verifiedPackage"] as const) {
      for (const name of ["", "paper", "../paper.zip", "paper/child.zip", " paper.zip", "paper.zip "]) {
        const response = successResponse();
        mutable(response.result.outputs[key]).name = name;
        expectInvalid(response);
      }
    }
  });

  it("rejects non-positive or unsafe file counts for either output", () => {
    for (const key of ["markdownZip", "verifiedPackage"] as const) {
      for (const fileCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const response = successResponse();
        mutable(response.result.outputs[key]).fileCount = fileCount;
        expectInvalid(response);
      }
    }
  });

  it("rejects malformed or internally inconsistent reports", () => {
    const badStatus = successResponse();
    mutable(badStatus.result.report).status = "failed";
    expectInvalid(badStatus);

    const badAlgorithm = successResponse();
    mutable(badAlgorithm.result.report).algorithm_version = "another-algorithm";
    expectInvalid(badAlgorithm);

    const badDerivedHash = successResponse();
    mutable(badDerivedHash.result.report).derived_article_sha256 = "not-a-sha256";
    expectInvalid(badDerivedHash);

    const failedCheck = successResponse();
    mutable(failedCheck.result.report.checks).source_tree_bound = false;
    expectInvalid(failedCheck);
  });

  it("rejects malformed summaries and report-summary mismatches", () => {
    const negativeCount = successResponse();
    negativeCount.result.summary.sourceImageCount = -1;
    expectInvalid(negativeCount);

    const nonInteger = successResponse();
    nonInteger.result.summary.visibleVisualCount = 1.5;
    expectInvalid(nonInteger);

    const mismatchedCount = successResponse();
    mismatchedCount.result.summary.sourceFileCount = 5;
    expectInvalid(mismatchedCount);

    const mismatchedPdfFlag = successResponse();
    mismatchedPdfFlag.result.summary.sourcePdfIncluded = true;
    expectInvalid(mismatchedPdfFlag);
  });

  it("rejects malformed repair and portable warning entries", () => {
    const unknownRepairWarning = successResponse();
    mutable(unknownRepairWarning.result.report).warnings = [{ code: "unknown-warning", count: 1 }];
    expectInvalid(unknownRepairWarning);

    const zeroRepairWarningCount = successResponse();
    mutable(zeroRepairWarningCount.result.report).warnings = [{ code: "source-pdf-unavailable", count: 0 }];
    expectInvalid(zeroRepairWarningCount);

    const unknownPortableWarning = successResponse();
    mutable(unknownPortableWarning.result.outputs.markdownZip).warnings = [{ code: "unknown-warning", count: 1 }];
    expectInvalid(unknownPortableWarning);

    const zeroPortableWarningCount = successResponse();
    mutable(zeroPortableWarningCount.result.outputs.markdownZip).warnings = [{
      code: "fragment-set-not-materialized",
      count: 0
    }];
    expectInvalid(zeroPortableWarningCount);

    const duplicatePortableWarnings = successResponse();
    mutable(duplicatePortableWarnings.result.outputs.markdownZip).warnings = [
      { code: "pdf-crop-not-materialized", count: 1 },
      { code: "pdf-crop-not-materialized", count: 1 }
    ];
    expectInvalid(duplicatePortableWarnings);
  });

  it("rejects unsupported Markdown representations and unavailable reasons", () => {
    const badRepresentation = successResponse();
    mutable(badRepresentation.result.outputs.markdownZip).representation = "reader-projection";
    expectInvalid(badRepresentation);

    const derivedWithFallbackWarning = successResponse();
    mutable(derivedWithFallbackWarning.result.outputs.markdownZip).representation = "portable-derived";
    expectInvalid(derivedWithFallbackWarning);

    const fallbackWithoutWarning = successResponse();
    mutable(fallbackWithoutWarning.result.outputs.markdownZip).warnings = [];
    expectInvalid(fallbackWithoutWarning);

    for (const reason of ["", "unknown-reason", 1]) {
      const response = successResponse();
      mutable(response.result.outputs).markdownZip = { status: "unavailable", reason };
      expectInvalid(response);
    }
  });

  it("accepts the v2 export progress stages and rejects invalid progress", () => {
    for (const stage of [
      "build-portable-export",
      "compress-portable-export",
      "compress-verified-package"
    ]) {
      expect(isRepairWorkerResponse({
        protocol: REPAIR_WORKER_PROTOCOL,
        type: "progress",
        requestId: REQUEST_ID,
        progress: { stage, percent: 90 }
      }, REQUEST_ID)).toBe(true);
    }

    expectInvalid({
      protocol: REPAIR_WORKER_PROTOCOL,
      type: "progress",
      requestId: REQUEST_ID,
      progress: { stage: "compress-portable-export", percent: 100.5 }
    });
  });
});
