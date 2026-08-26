import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVisualReviewSidecar,
  prepareMinerUVisualReview,
  type MinerUVisualReviewDecision
} from "../src/model/mineru-visual-review";
import { applyMinerUVisualRepair } from "../src/model/mineru-visual-repair";

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

function crossPageFixture() {
  const articleMarkdown = "Body before.\n\nFigure 4. Cross-page result continues\n\nwith panels b and c.\n\nBody after.\n";
  const mineruPayload = [
    { type: "image", img_path: "images/source.png" },
    { type: "text", text: "Figure 4. Cross-page result continues" },
    { type: "text", text: "with panels b and c." }
  ];
  const source = {
    id: "source-visual", source_index: 0, page_order: 0, role: "visual", bbox_norm: [100, 480, 720, 900],
    asset_path: "images/source.png", markdown_image_ids: ["md-source"], text: { formal_figure_caption_keys: [] },
    caption: {
      next_page_marker: true,
      figure_keys: ["figure:4"],
      next_page_figure_keys: ["figure:4"],
      next_page_placeholders: [{ figure_key: "figure:4", text: "Figure 4 (continued on next page)" }]
    }
  };
  const anchor = {
    id: "caption-anchor", source_index: 1, page_order: 0, role: "text", bbox_norm: [100, 80, 440, 180],
    markdown_image_ids: [], caption: { formal_figure_caption_keys: [] },
    text: {
      leading_figure_key: "figure:4", leading_formal_figure_caption_key: "figure:4",
      formal_figure_caption_keys: ["figure:4"], starts_with_lowercase: false,
      starts_with_panel_label: false, ends_with_terminal_punctuation: false
    }
  };
  const continuation = {
    id: "caption-continuation", source_index: 2, page_order: 1, role: "text", bbox_norm: [460, 80, 800, 180],
    markdown_image_ids: [], caption: { formal_figure_caption_keys: [] },
    text: {
      leading_figure_key: null, leading_formal_figure_caption_key: null, formal_figure_caption_keys: [],
      starts_with_lowercase: true, starts_with_panel_label: false, ends_with_terminal_punctuation: true
    }
  };
  const viewerIndex = {
    schema_version: 1,
    inputs: { article: { sha256: articleHash }, mineru_result: { sha256: mineruHash } },
    pages: [{ page_idx: 0, blocks: [source] }, { page_idx: 1, blocks: [anchor, continuation] }]
  };
  const visualRepair = {
    schema_version: 1,
    inputs: { article: { sha256: articleHash }, mineru_result: { sha256: mineruHash } },
    groups: [],
    caption_links: [{
      visual_block_id: source.id,
      caption_block_ids: [anchor.id],
      source_page_idx: 0,
      target_page_idx: 1,
      figure_key: "figure:4",
      relation: "next_page_figure_caption",
      status: "partial"
    }]
  };
  const inputs = {
    article: { sha256: articleHash }, mineru_result: { sha256: mineruHash },
    viewer_index_sha256: digest(viewerIndex), visual_repair_sha256: digest(visualRepair)
  };
  const candidateMaterial = {
    kind: "cross_page_caption",
    review_state: "partial",
    visual_block_id: source.id,
    source_page_idx: 0,
    target_page_idx: 1,
    figure_key: "figure:4",
    caption_block_ids: [anchor.id],
    evidence: {
      source_geometry: { block_id: source.id, page_idx: 0, page_order: 0, bbox_norm: source.bbox_norm, role: "visual" },
      caption_geometry: [{ block_id: anchor.id, page_idx: 1, page_order: 0, bbox_norm: anchor.bbox_norm, role: "text" }],
      source_caption_summary: {}, caption_text_summaries: [{}], issue_code: "partial_next_page_figure_caption"
    }
  };
  const candidate = {
    candidate_id: `caption-${digest({ schema_version: 1, inputs, candidate: candidateMaterial }).slice(0, 24)}`,
    ...candidateMaterial
  };
  const packageMaterial = {
    schema_version: 1, contract: "mineru-visual-candidates", status: "ready", inputs,
    policy: { allowed_verdicts: ["accept", "reject", "abstain"], minimum_accept_confidence: 0.85 },
    candidates: [candidate], issues: []
  };
  return {
    articleMarkdown,
    mineruPayload,
    viewerIndex,
    visualRepair,
    candidate,
    candidatePackage: { ...packageMaterial, candidate_package_sha256: digest(packageMaterial) }
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

  it("revalidates and accepts an existing cross-page caption candidate without AI", async () => {
    const input = crossPageFixture();
    const result = await prepareMinerUVisualReview({
      ...input,
      articleHash,
      mineruHash,
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [{
        candidate_id: input.candidate.candidate_id,
        verdict: "accept",
        correction: null
      }])
    });

    expect((result.visualRepair as { caption_links: Array<Record<string, unknown>> }).caption_links).toEqual([
      expect.objectContaining({ visual_block_id: "source-visual", caption_block_ids: ["caption-anchor"], status: "partial" })
    ]);
    expect(result.review?.blocks.some((block) => block.id === "caption-anchor" && block.text?.startsWith("Figure 4"))).toBe(true);
  });

  it("removes a rejected cross-page caption link from the runtime projection", async () => {
    const input = crossPageFixture();
    const result = await prepareMinerUVisualReview({
      ...input,
      articleHash,
      mineruHash,
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [{
        candidate_id: input.candidate.candidate_id,
        verdict: "reject",
        correction: null
      }])
    });

    expect((result.visualRepair as { caption_links: unknown[] }).caption_links).toEqual([]);
  });

  it("accepts a user-respecified continuation only after page, geometry, Figure key, and Markdown checks", async () => {
    const input = crossPageFixture();
    const source = JSON.stringify(input.visualRepair);
    const result = await prepareMinerUVisualReview({
      ...input,
      articleHash,
      mineruHash,
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [{
        candidate_id: input.candidate.candidate_id,
        verdict: "reject",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: "source-visual",
          caption_block_ids: ["caption-anchor", "caption-continuation"]
        }
      }])
    });

    expect((result.visualRepair as { caption_links: Array<Record<string, unknown>> }).caption_links).toEqual([
      expect.objectContaining({
        visual_block_id: "source-visual",
        caption_block_ids: ["caption-anchor", "caption-continuation"],
        figure_key: "figure:4",
        status: "complete"
      })
    ]);
    expect(result.review?.decisions[0].correction).toMatchObject({ kind: "cross_page_caption" });
    expect(JSON.stringify(input.visualRepair)).toBe(source);
  });

  it("rejects a cross-page correction when the selected text is not unique in Markdown", async () => {
    const input = crossPageFixture();
    input.articleMarkdown += "\nwith panels b and c.\n";
    const result = await prepareMinerUVisualReview({
      ...input,
      articleHash,
      mineruHash,
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [{
        candidate_id: input.candidate.candidate_id,
        verdict: "reject",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: "source-visual",
          caption_block_ids: ["caption-anchor", "caption-continuation"]
        }
      }])
    });

    expect((result.visualRepair as { caption_links: unknown[] }).caption_links).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "mineru-user-correction-rejected" && item.message.includes("唯一精确区间"))).toBe(true);
  });

  it("projects the validated user caption relationship without writing to article Markdown", async () => {
    const input = crossPageFixture();
    const prepared = await prepareMinerUVisualReview({
      ...input,
      articleHash,
      mineruHash,
      sidecar: createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, [{
        candidate_id: input.candidate.candidate_id,
        verdict: "reject",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: "source-visual",
          caption_block_ids: ["caption-anchor", "caption-continuation"]
        }
      }])
    });
    const projected = applyMinerUVisualRepair({
      visuals: [{
        id: "source-visual",
        kind: "figure",
        path: "images/source.png",
        label: "Figure 4",
        pageIndex: 0,
        bbox: { x: 0.1, y: 0.48, width: 0.62, height: 0.42 }
      }],
      viewerIndex: input.viewerIndex,
      visualRepair: prepared.visualRepair,
      mineruPayload: input.mineruPayload,
      articleMarkdown: input.articleMarkdown,
      articleHash,
      mineruHash
    });

    expect(projected.visuals[0]).toMatchObject({
      captionText: "Figure 4. Cross-page result continues with panels b and c.",
      captionPageIndex: 1,
      captionStatus: "complete"
    });
    expect(projected.visuals[0].captionSourceRanges).toHaveLength(2);
    expect(input.articleMarkdown).toContain("Figure 4. Cross-page result continues");
  });

  it("rejects user-supplied cross-page coordinates or caption prose", async () => {
    const input = crossPageFixture();
    const sidecar = createVisualReviewSidecar(input.candidatePackage.candidate_package_sha256, []) as unknown as Record<string, unknown>;
    sidecar.decisions = [{
      candidate_id: input.candidate.candidate_id,
      verdict: "reject",
      correction: {
        kind: "cross_page_caption",
        visual_block_id: "source-visual",
        caption_block_ids: ["caption-anchor"],
        bbox_norm: [0, 0, 1000, 1000],
        caption_text: "Injected caption"
      }
    }];
    const result = await prepareMinerUVisualReview({ ...input, articleHash, mineruHash, sidecar });

    expect(result.review?.decisions).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "mineru-user-review-sidecar-invalid")).toBe(true);
    expect((result.visualRepair as { caption_links: unknown[] }).caption_links).toHaveLength(1);
  });
});
