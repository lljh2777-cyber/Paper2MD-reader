import { describe, expect, it } from "vitest";
import {
  applyRecoveredParagraph,
  applyRecoveredText,
  collectMinerUParagraphRecoveryRequests,
  collectMinerUTextRecoveryCandidates,
  recoverMinerUParagraph,
  recoverReplacementCharacters
} from "../src/model/mineru-text-recovery";

const source = "In these equations, parameters of the model (biases or matrices) and � represents the set of neighbors of a cell in the subgraph �. After L sequential layers, each node has a feature vector. Then, to obtain a unified representation for the entire subgraph �, we employ an attention aggregation layer.";
const pdfText = "In these equations, parameters of the model (biases or matrices) and 𝒩𝒩 represents the set of neighbors of a cell in the subgraph 𝒢𝒢. After L sequential layers, each node has a feature vector. Then, to obtain a unified representation for the entire subgraph 𝒢𝒢, we employ an attention aggregation layer.";

const previousParagraph = "Previous complete paragraph provides a unique and stable source anchor.";
const nextParagraph = "Next complete paragraph provides another unique and stable source anchor.";
const missingParagraph = "The omitted paragraph contains enough unique scientific prose to be restored safely.";
const paragraphMarkdown = `# Paper\n\n${previousParagraph}\n\n${nextParagraph}\n`;

function paragraphFixture(options?: { duplicateId?: boolean; overlapVisual?: boolean; gapText?: string }) {
  const markdown = options?.gapText === undefined
    ? paragraphMarkdown
    : `# Paper\n\n${previousParagraph}\n\n${options.gapText}\n\n${nextParagraph}\n`;
  const blocks = [
    {
      id: "p0000-s000000",
      source_index: 0,
      page_order: 0,
      role: "text",
      bbox_norm: [50, 100, 450, 250],
      text: { char_count: previousParagraph.length },
      caption: { char_count: 0 }
    },
    {
      id: options?.duplicateId ? "p0000-s000000" : "p0000-s000001",
      source_index: 1,
      page_order: 1,
      role: "text",
      bbox_norm: [50, 260, 450, 400],
      text: { char_count: 0 },
      caption: { char_count: 0 }
    },
    {
      id: "p0000-s000002",
      source_index: 2,
      page_order: 2,
      role: "text",
      bbox_norm: [50, 410, 450, 550],
      text: { char_count: nextParagraph.length },
      caption: { char_count: 0 }
    },
    ...(options?.overlapVisual ? [{
      id: "p0000-s000003",
      source_index: 3,
      page_order: 3,
      role: "visual",
      bbox_norm: [60, 270, 440, 390],
      text: { char_count: 0 },
      caption: { char_count: 0 }
    }] : [])
  ];
  return {
    markdown,
    viewerIndex: { pages: [{ page_idx: 0, blocks }] },
    mineruPayload: [
      { type: "text", page_idx: 0, bbox: [50, 100, 450, 250], text: previousParagraph },
      { type: "text", page_idx: 0, bbox: [50, 260, 450, 400], text: "" },
      { type: "text", page_idx: 0, bbox: [50, 410, 450, 550], text: nextParagraph },
      ...(options?.overlapVisual ? [{ type: "image", page_idx: 0, bbox: [60, 270, 440, 390], img_path: "images/overlap.png" }] : [])
    ]
  };
}

describe("MinerU PDF text recovery", () => {
  it("recovers uniquely bounded duplicated mathematical glyphs", () => {
    const recovered = recoverReplacementCharacters(source, pdfText);
    expect(recovered).toEqual({
      text: source.replace("�", "𝒩").replace("�", "𝒢").replace("�", "𝒢"),
      recoveredCount: 3
    });
  });

  it("abstains when the PDF context is ambiguous or incomplete", () => {
    expect(recoverReplacementCharacters(source, `${pdfText} ${pdfText}`)).toBeUndefined();
    expect(recoverReplacementCharacters(source, "unrelated PDF text")).toBeUndefined();
  });

  it("uses a unique punctuation-bound right context when malformed LaTeX removed the left anchor", () => {
    const malformed = "during training, and ${ \\bf h } = embed({ \\bf x }, i $ �) during inference. For each layer l, the node features are calculated.";
    const pdf = "during training, and h = embed(x, 𝒫𝒫) during inference. For each layer l, the node features are calculated.";
    expect(recoverReplacementCharacters(malformed, pdf)?.text).toContain("𝒫) during inference");
  });

  it("collects only uniquely located text blocks with valid page geometry", () => {
    const raw = [{ type: "text", page_idx: 12, bbox: [507, 641, 946, 836], text: source }];
    expect(collectMinerUTextRecoveryCandidates(raw, `# Paper\n\n${source}\n`)).toEqual([{
      id: "mineru-text-000000",
      pageIndex: 12,
      bbox: { x: 0.507, y: 0.641, width: 0.439, height: 0.195 },
      sourceText: source
    }]);
    expect(collectMinerUTextRecoveryCandidates(raw, `${source}\n${source}`)).toEqual([]);
  });

  it("keeps candidate source indexes aligned with Viewer flattening", () => {
    const valid = { type: "text", page_idx: 2, bbox: [100, 100, 900, 300], text: source };
    expect(collectMinerUTextRecoveryCandidates([null, valid], source)).toMatchObject([{
      id: "mineru-text-000001",
      pageIndex: 2
    }]);
    expect(collectMinerUTextRecoveryCandidates([[valid], valid], source)).toMatchObject([{
      id: "mineru-text-000001",
      pageIndex: 2
    }]);
    expect(collectMinerUTextRecoveryCandidates([[null, { ...valid, page_idx: undefined }]], source)).toMatchObject([{
      id: "mineru-text-000001",
      pageIndex: 0
    }]);
  });

  it("applies recovered text only when the source block is unique", () => {
    const recovered = source.replace("�", "𝒩").replace("�", "𝒢").replace("�", "𝒢");
    expect(applyRecoveredText(`# Paper\n\n${source}`, source, recovered)).toContain("𝒩");
    expect(applyRecoveredText(`${source}\n${source}`, source, recovered)).toBeUndefined();
  });

  it("collects and restores one empty body block between exact Markdown anchors", () => {
    const fixture = paragraphFixture();
    const [request] = collectMinerUParagraphRecoveryRequests(fixture);
    expect(request).toMatchObject({
      id: "mineru-paragraph-000001",
      sourceBlockId: "p0000-s000001",
      pageIndex: 0,
      bbox: { x: 0.05, y: 0.26, width: 0.4, height: 0.14 },
      previous: { text: previousParagraph },
      next: { text: nextParagraph }
    });
    const recovered = recoverMinerUParagraph(fixture.markdown, request, missingParagraph);
    expect(recovered?.text).toBe(missingParagraph);
    const projected = applyRecoveredParagraph(fixture.markdown, recovered!);
    expect(projected).toContain(`${previousParagraph}\n\n${missingParagraph}\n\n${nextParagraph}`);
    expect(fixture.markdown).toBe(paragraphMarkdown);
  });

  it("normalizes PDF line-wrap hyphenation before inserting a recovered paragraph", () => {
    const fixture = paragraphFixture();
    const [request] = collectMinerUParagraphRecoveryRequests(fixture);
    const recovered = recoverMinerUParagraph(
      fixture.markdown,
      request,
      "The omitted para- graph contains enough unique scientific prose to be restored safely."
    );
    expect(recovered?.text).toContain("omitted paragraph");
  });

  it("abstains from captions, incomplete continuations, and text already present in Markdown", () => {
    const fixture = paragraphFixture();
    const [request] = collectMinerUParagraphRecoveryRequests(fixture);
    expect(recoverMinerUParagraph(fixture.markdown, request, "Fig. 4 | This caption is long enough to resemble a paragraph but must remain a caption.")).toBeUndefined();
    expect(recoverMinerUParagraph(fixture.markdown, request, "the omitted paragraph contains enough unique prose but begins as a continuation and ends safely.")).toBeUndefined();
    expect(recoverMinerUParagraph(fixture.markdown, request, "The omitted paragraph contains enough unique prose but has no terminal punctuation")).toBeUndefined();
    expect(recoverMinerUParagraph(`${fixture.markdown}\n${missingParagraph}`, request, missingParagraph)).toBeUndefined();
  });

  it("rejects ambiguous source structure, occupied gaps, protected overlap, and caption claims", () => {
    expect(collectMinerUParagraphRecoveryRequests(paragraphFixture({ duplicateId: true }))).toEqual([]);
    expect(collectMinerUParagraphRecoveryRequests(paragraphFixture({ overlapVisual: true }))).toEqual([]);
    expect(collectMinerUParagraphRecoveryRequests(paragraphFixture({ gapText: "Existing Markdown content." }))).toEqual([]);
    const fixture = paragraphFixture();
    expect(collectMinerUParagraphRecoveryRequests({
      ...fixture,
      excludeBlockIds: ["p0000-s000001"]
    })).toEqual([]);
  });

  it("fails closed before indexing an oversized viewer page", () => {
    const blocks = Array.from({ length: 513 }, (_, index) => ({
      id: `p0000-s${index.toString().padStart(6, "0")}`,
      source_index: index,
      page_order: index,
      role: "text",
      bbox_norm: [50, 100, 450, 250],
      text: { char_count: index === 1 ? 0 : 40 },
      caption: { char_count: 0 }
    }));
    expect(collectMinerUParagraphRecoveryRequests({
      viewerIndex: { pages: [{ page_idx: 0, blocks }] },
      mineruPayload: blocks.map((_, index) => ({ type: "text", text: index === 1 ? "" : `Unique anchor text number ${index} is long enough for validation.` })),
      markdown: paragraphMarkdown
    })).toEqual([]);
  });

  it("escapes active Markdown and HTML syntax in recovered PDF text", () => {
    const fixture = paragraphFixture();
    const [request] = collectMinerUParagraphRecoveryRequests(fixture);
    const hostile = "The recovered paragraph mentions ![remote](https://example.com/a.png) and <script>alert(1)</script> as inert text.";
    const recovered = recoverMinerUParagraph(fixture.markdown, request, hostile)!;
    const projected = applyRecoveredParagraph(fixture.markdown, recovered)!;
    expect(projected).toContain("\\!\\[remote\\]");
    expect(projected).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(projected).not.toContain("<script>");
  });

  it("refuses to insert when projection anchors are no longer unique or the gap changed", () => {
    const fixture = paragraphFixture();
    const [request] = collectMinerUParagraphRecoveryRequests(fixture);
    const recovered = recoverMinerUParagraph(fixture.markdown, request, missingParagraph)!;
    expect(applyRecoveredParagraph(`${fixture.markdown}\n${previousParagraph}`, recovered)).toBeUndefined();
    expect(applyRecoveredParagraph(
      fixture.markdown.replace(
        `${previousParagraph}\n\n${nextParagraph}`,
        `${previousParagraph}\n\nUnexpected text\n\n${nextParagraph}`
      ),
      recovered
    )).toBeUndefined();
  });
});
