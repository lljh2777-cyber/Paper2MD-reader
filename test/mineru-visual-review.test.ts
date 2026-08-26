import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVisualReviewSidecar,
  prepareMinerUVisualReview,
  type MinerUVisualReviewDecision
} from "../src/model/mineru-visual-review";

const articleHash = "a".repeat(64);
const mineruHash = "b".repeat(64);

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fixture() {
  const blocks = [
    { id: "block-a", page_order: 0, bbox_norm: [100, 100, 300, 400], asset_path: "images/a.png", markdown_image_ids: ["md-a"] },
    { id: "block-b", page_order: 1, bbox_norm: [305, 100, 505, 400], asset_path: "images/b.png", markdown_image_ids: ["md-b"] },
    { id: "block-c", page_order: 2, bbox_norm: [510, 100, 710, 400], asset_path: "images/c.png", markdown_image_ids: ["md-c"] }
  ].map((block) => ({
    ...block,
    source_index: block.page_order,
    role: "visual",
    caption: { formal_figure_caption_keys: ["figure:2"] },
    text: { formal_figure_caption_keys: [] }
  }));
  const viewerIndex = {
    schema_version: 1,
    inputs: { article: { sha256: articleHash }, mineru_result: { sha256: mineruHash } },
    pages: [{ page_idx: 0, blocks }]
  };
  const visualRepair = {
    schema_version: 1,
    inputs: { article: { sha256: articleHash }, mineru_result: { sha256: mineruHash } },
    groups: [{
      id: "repair-review",
      page_idx: 0,
      member_block_ids: ["block-a", "block-b"],
      member_asset_paths: ["images/a.png", "images/b.png"],
      member_markdown_image_ids: ["md-a", "md-b"],
      caption_anchor_block_ids: [],
      decision: "review",
      confidence: 0.72,
      replacement: { mode: "pdf_crop", bbox_norm: [100, 100, 505, 400], padding_norm: 6 }
    }],
    caption_links: []
  };
  const inputs = {
    article: { sha256: articleHash },
    mineru_result: { sha256: mineruHash },
    viewer_index_sha256: digest(viewerIndex),
    visual_repair_sha256: digest(visualRepair)
  };
  const candidateMaterial = {
    kind: "fragment_group",
    review_state: "review",
    repair_group_id: "repair-review",
    page_idx: 0,
    member_block_ids: ["block-a", "block-b"],
    replacement_mode: "pdf_crop",
    base_confidence: 0.72,
    evidence: {
      member_geometry: blocks.slice(0, 2).map((block) => ({
        block_id: block.id,
        page_idx: 0,
        page_order: block.page_order,
        bbox_norm: block.bbox_norm,
        role: "visual"
      })),
      caption_anchor_block_ids: [],
      signals: {},
      reason_codes: [],
      warning_codes: []
    }
  };
  const candidate = {
    candidate_id: `fragment-${digest({ schema_version: 1, inputs, candidate: candidateMaterial }).slice(0, 24)}`,
    ...candidateMaterial
  };
  const packageMaterial = {
    schema_version: 1,
    contract: "mineru-visual-candidates",
    status: "ready",
    inputs,
    policy: { allowed_verdicts: ["accept", "reject", "abstain"], minimum_accept_confidence: 0.85 },
    candidates: [candidate],
    issues: []
  };
  const candidatePackage = { ...packageMaterial, candidate_package_sha256: digest(packageMaterial) };
  return { viewerIndex, visualRepair, candidatePackage, candidate };
}

function decision(candidateId: string, memberIds?: string[]): MinerUVisualReviewDecision {
  return {
    candidate_id: candidateId,
    verdict: memberIds ? "reject" : "accept",
    correction: memberIds ? { kind: "fragment_group", member_block_ids: memberIds } : null
  };
}

describe("prepareMinerUVisualReview", () => {
  it("accepts an existing bounded candidate without editing the source contracts", async () => {
    const input = fixture();
    const source = JSON.stringify(input.visualRepair);
    const result = await prepareMinerUVisualReview({
      candidatePackage: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf",
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [decision(input.candidate.candidate_id)])
    });

    expect(result.review?.decisions).toHaveLength(1);
    expect((result.visualRepair as { groups: Array<{ decision: string }> }).groups[0].decision).toBe("auto");
    expect(JSON.stringify(input.visualRepair)).toBe(source);
  });

  it("derives a replacement crop only after the user's corrected group passes geometry checks", async () => {
    const input = fixture();
    const result = await prepareMinerUVisualReview({
      candidatePackage: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf",
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [
        decision(input.candidate.candidate_id, ["block-a", "block-b", "block-c"])
      ])
    });

    const groups = (result.visualRepair as { groups: Array<Record<string, unknown>> }).groups;
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({
      id: `user-${input.candidate.candidate_id}`,
      decision: "auto",
      member_block_ids: ["block-a", "block-b", "block-c"],
      replacement: { mode: "pdf_crop", bbox_norm: [100, 100, 710, 400] }
    });
    expect(result.diagnostics.some((item) => item.code === "mineru-user-correction-rejected")).toBe(false);
  });

  it("rejects a disconnected corrected group and keeps the deterministic repair", async () => {
    const input = fixture();
    input.viewerIndex.pages[0].blocks[2].bbox_norm = [800, 700, 950, 900];
    const result = await prepareMinerUVisualReview({
      candidatePackage: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf",
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [
        decision(input.candidate.candidate_id, ["block-a", "block-c"])
      ])
    });

    expect((result.visualRepair as { groups: unknown[] }).groups).toHaveLength(1);
    expect(result.diagnostics.some((item) => item.code === "mineru-user-correction-rejected" && item.message.includes("不连通"))).toBe(true);
  });

  it("ignores stale or field-injecting sidecars without hiding the verified candidates", async () => {
    const input = fixture();
    const malicious = {
      ...createVisualReviewSidecar("c".repeat(64), []),
      decisions: [{
        candidate_id: input.candidate.candidate_id,
        verdict: "reject",
        correction: { kind: "fragment_group", member_block_ids: ["block-a", "block-c"], bbox: [0, 0, 1000, 1000] }
      }]
    };
    const result = await prepareMinerUVisualReview({
      candidatePackage: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash,
      mineruHash,
      sidecar: malicious
    });

    expect(result.review?.candidates).toHaveLength(1);
    expect(result.review?.decisions).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "mineru-user-review-sidecar-invalid")).toBe(true);
    expect((result.visualRepair as { groups: unknown[] }).groups).toHaveLength(1);
  });

  it("fails closed when candidate geometry no longer matches viewer-index", async () => {
    const input = fixture();
    input.candidatePackage.candidates[0].evidence.member_geometry[0].bbox_norm = [0, 0, 50, 50];
    const material = { ...input.candidatePackage };
    delete (material as Partial<typeof input.candidatePackage>).candidate_package_sha256;
    input.candidatePackage.candidate_package_sha256 = digest(material);
    const result = await prepareMinerUVisualReview({
      candidatePackage: input.candidatePackage,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleHash,
      mineruHash
    });

    expect(result.review).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "mineru-visual-review-invalid")).toBe(true);
  });
});
