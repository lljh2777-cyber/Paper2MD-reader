import { describe, expect, it } from "vitest";
import { ConversionTask } from "../apps/desktop/src/shared/desktop-api";
import {
  DESKTOP_TASK_STORE_VERSION,
  parseTaskStoreJson,
  persistentTask,
  reviewedRecoveryPoint,
  taskStoreJson
} from "../apps/desktop/src/main/task-persistence";

const task: ConversionTask = {
  id: "81b2c2f6-1953-4781-ac9c-ad539987b0c2",
  pdfName: "paper.pdf",
  outputName: "paper-paper2md",
  workflow: "direct",
  stage: "complete",
  state: "succeeded",
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:01:00.000Z",
  message: "Conversion finished",
  packageRootId: "ephemeral-package-token",
  artifactRootId: "ephemeral-artifact-token",
  recovered: true
};

const job = {
  kind: "direct" as const,
  pdfPath: "C:\\papers\\paper.pdf",
  outputPath: "C:\\exports\\paper-paper2md",
  request: { backend: "pdfium" as const, regionRenderMode: "off" as const }
};

describe("desktop task persistence", () => {
  it("round-trips a versioned task while stripping process-local tokens", () => {
    const text = taskStoreJson([{ task: persistentTask(task), job }]);
    expect(text).toContain(DESKTOP_TASK_STORE_VERSION);
    expect(text).not.toContain("ephemeral-package-token");
    expect(text).not.toContain("ephemeral-artifact-token");
    expect(text).not.toContain('"recovered"');

    const parsed = parseTaskStoreJson(text);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].task.state).toBe("succeeded");
    expect(parsed.entries[0].job).toEqual(job);
  });

  it("ignores invalid entries without discarding valid task history", () => {
    const valid = JSON.parse(taskStoreJson([{ task: persistentTask(task), job }]));
    valid.entries.push({
      task: { ...valid.entries[0].task, id: "bad", workflow: "reviewed-layout" },
      job
    });
    const parsed = parseTaskStoreJson(JSON.stringify(valid));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics).toEqual(["Ignored invalid task entry 2"]);
  });

  it("rejects an unknown store contract", () => {
    expect(() => parseTaskStoreJson('{"contract_version":"unknown","entries":[]}')).toThrow("contract");
  });

  it("chooses the safest reviewed recovery point from strongest disk evidence", () => {
    const baseline = {
      outputReady: false,
      outputExists: false,
      layoutReviewReady: false,
      confirmedRoiReady: false,
      roiProposalReady: false
    };
    expect(reviewedRecoveryPoint(baseline)).toBe("roi-proposal");
    expect(reviewedRecoveryPoint({ ...baseline, roiProposalReady: true })).toBe("roi-review");
    expect(reviewedRecoveryPoint({ ...baseline, confirmedRoiReady: true })).toBe("layout-prepare");
    expect(reviewedRecoveryPoint({ ...baseline, layoutReviewReady: true })).toBe("layout-review");
    expect(reviewedRecoveryPoint({ ...baseline, outputExists: true, layoutReviewReady: true })).toBe("partial-output");
    expect(reviewedRecoveryPoint({ ...baseline, outputReady: true, outputExists: true })).toBe("complete");
  });
});
