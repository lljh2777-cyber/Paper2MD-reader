import { describe, expect, it } from "vitest";
import { applyMinerUVisualRepair } from "../src/model/mineru-visual-repair";
import { MinerUVisual } from "../src/model/mineru-content-list";
import { projectMinerUReaderMarkdown } from "../src/model/mineru-reader-projection";

const articleHash = "article-hash";
const mineruHash = "mineru-hash";
const caption = "Fig. 5. A complete caption for the full-page multi-panel figure.";

function contractInputs() {
  return {
    article: { sha256: articleHash },
    mineru_result: { sha256: mineruHash }
  };
}

function fixture(includeBody = false) {
  const paths = ["images/a.png", "images/b.png", "images/c.png", "images/d.png"];
  const articleMarkdown = `# Paper\n\n${paths.map((path) => `![](${path})`).join("\n\n")}\n\n${caption}\n`;
  const visuals: MinerUVisual[] = paths.map((path, index) => ({
    id: `ast_${index}`,
    kind: "figure",
    path,
    label: `Figure ${index + 1}`,
    pageIndex: 0,
    placementBlockId: `slot_${index}`
  }));
  const blocks = paths.map((path, index) => ({
    id: `p0000-s00000${index}`,
    source_index: index,
    page_order: index,
    role: "visual",
    asset_path: path,
    bbox_norm: [100 + (index % 2) * 400, 50 + Math.floor(index / 2) * 450, 500 + (index % 2) * 400, 500 + Math.floor(index / 2) * 450],
    markdown_image_ids: [`md-img-000${index}`],
    caption: {
      items: [{ text: String.fromCharCode(65 + index), kind: "panel-label" }],
      formal_figure_caption_keys: [],
      next_page_marker: false
    },
    text: { formal_figure_caption_keys: [] }
  }));
  const raw = paths.map((path, index) => ({
    type: "image",
    page_idx: 0,
    bbox: blocks[index].bbox_norm,
    img_path: path,
    image_caption: [String.fromCharCode(65 + index)]
  }));
  if (includeBody) {
    blocks.push({
      id: "p0000-s000004",
      source_index: raw.length,
      page_order: blocks.length,
      role: "text",
      asset_path: "",
      bbox_norm: [100, 960, 900, 990],
      markdown_image_ids: [],
      caption: { items: [], formal_figure_caption_keys: [], next_page_marker: false },
      text: { formal_figure_caption_keys: [] }
    });
    raw.push({ type: "text", page_idx: 0, bbox: [100, 960, 900, 990], text: "Body text makes this page ambiguous." } as never);
  }
  const captionSourceIndex = raw.length;
  raw.push({ type: "text", page_idx: 1, bbox: [80, 40, 920, 260], text: caption } as never);
  const viewerIndex = {
    schema_version: 1,
    inputs: contractInputs(),
    pages: [
      { page_idx: 0, blocks },
      {
        page_idx: 1,
        blocks: [{
          id: `p0001-s${captionSourceIndex.toString().padStart(6, "0")}`,
          source_index: captionSourceIndex,
          page_order: 0,
          role: "text",
          bbox_norm: [80, 40, 920, 260],
          text: {
            leading_formal_figure_caption_key: "figure:5",
            formal_figure_caption_keys: ["figure:5"],
            ends_with_terminal_punctuation: true
          },
          caption: { items: [] }
        }]
      }
    ]
  };
  const visualRepair = {
    schema_version: 1,
    inputs: contractInputs(),
    groups: [
      {
        id: "group-left",
        page_idx: 0,
        member_block_ids: blocks.slice(0, 2).map((block) => block.id),
        member_asset_paths: paths.slice(0, 2),
        member_markdown_image_ids: ["md-img-0000", "md-img-0001"],
        decision: "auto",
        confidence: 0.9,
        replacement: { mode: "pdf_crop", bbox_norm: [100, 50, 900, 500], padding_norm: 6 }
      },
      {
        id: "group-right",
        page_idx: 0,
        member_block_ids: blocks.slice(2, 4).map((block) => block.id),
        member_asset_paths: paths.slice(2, 4),
        member_markdown_image_ids: ["md-img-0002", "md-img-0003"],
        decision: "auto",
        confidence: 0.85,
        replacement: { mode: "pdf_crop", bbox_norm: [100, 500, 900, 950], padding_norm: 6 }
      }
    ],
    caption_links: []
  };
  return { articleMarkdown, visuals, viewerIndex, visualRepair, raw };
}

describe("applyMinerUVisualRepair full-page cross-page caption inference", () => {
  it("consolidates multiple repair groups and omitted edge fragments only with unique page-level evidence", () => {
    const input = fixture();
    const originalMarkdown = input.articleMarkdown;
    const result = applyMinerUVisualRepair({
      visuals: input.visuals,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      mineruPayload: input.raw,
      articleMarkdown: input.articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(result.visuals).toHaveLength(1);
    expect(result.visuals[0]).toMatchObject({
      label: "Fig. 5",
      captionText: caption,
      captionPageIndex: 1,
      captionStatus: "complete",
      memberAssetPaths: ["images/a.png", "images/b.png", "images/c.png", "images/d.png"],
      display: {
        mode: "pdf-crop",
        pdfPath: "_extraction/source.pdf",
        bbox: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 }
      }
    });
    expect(result.diagnostics.some((entry) => entry.code === "mineru-full-page-visual-consolidated")).toBe(true);
    expect(input.articleMarkdown).toBe(originalMarkdown);
  });

  it("keeps the original groups when the source page also contains body text", () => {
    const input = fixture(true);
    const result = applyMinerUVisualRepair({
      visuals: input.visuals,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      mineruPayload: input.raw,
      articleMarkdown: input.articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(result.visuals).toHaveLength(2);
    expect(result.visuals.every((visual) => visual.captionPageIndex === undefined)).toBe(true);
    expect(result.diagnostics.some((entry) => entry.code === "mineru-full-page-visual-consolidated")).toBe(false);
  });
});

function samePageSplitCaptionFixture(terminalContinuation = true) {
  const paths = ["images/a.png", "images/b.png", "images/c.png", "images/d.png"];
  const formal = "Fig. 6 | Downstream tasks. a, First panel. b, Second panel. d, Organization of nondiseased";
  const continuation = terminalContinuation
    ? "(left) and reactive (right) lymph nodes. e, Mouse brain domains. f, Aging heatmap. g, Gene expression patterns."
    : "(left) and reactive (right) lymph nodes without a verified ending";
  const articleMarkdown = [
    "# Paper",
    "",
    "d  ",
    "e  ",
    `![](${paths[0]})`,
    "",
    `![](${paths[1]})  `,
    formal,
    "",
    `![](${paths[2]})`,
    "",
    `![](${paths[3]})  `,
    continuation,
    "",
    "Body remains."
  ].join("\n");
  const visuals: MinerUVisual[] = paths.map((path, index) => ({
    id: `ast_${index}`,
    kind: "figure",
    path,
    label: `Figure ${index + 1}`,
    pageIndex: 0,
    placementBlockId: `slot_${index}`
  }));
  const blocks = paths.map((path, index) => ({
    id: `p0000-s00000${index}`,
    source_index: index,
    page_order: index,
    role: "visual",
    asset_path: path,
    bbox_norm: [100 + index * 180, 50, 260 + index * 180, 700],
    markdown_image_ids: [`md-img-000${index}`],
    text: { formal_figure_caption_keys: [] },
    caption: {
      items: index === 0
        ? [{ text: "d", kind: "panel-label" }, { text: "e", kind: "panel-label" }]
        : index === 1
          ? [{ text: formal, kind: "formal-caption" }]
        : index === 3
          ? [{ text: continuation, kind: "caption-continuation" }]
          : [],
      formal_figure_caption_keys: index === 1 ? ["figure:6"] : []
    }
  }));
  const markdownImages = paths.map((path, index) => {
    const token = `![](${path})`;
    const start = articleMarkdown.indexOf(token);
    return { id: `md-img-000${index}`, asset_path: path, char_start: start, char_end: start + token.length };
  });
  return {
    formal,
    continuation,
    articleMarkdown,
    visuals,
    viewerIndex: {
      schema_version: 1,
      inputs: contractInputs(),
      markdown_images: markdownImages,
      pages: [{ page_idx: 0, blocks }]
    },
    visualRepair: {
      schema_version: 1,
      inputs: contractInputs(),
      groups: [{
        id: "group-six",
        page_idx: 0,
        member_block_ids: blocks.map((block) => block.id),
        member_asset_paths: paths,
        member_markdown_image_ids: markdownImages.map((image) => image.id),
        caption_anchor_block_ids: [blocks[1].id, blocks[3].id],
        decision: "auto",
        confidence: 0.95,
        replacement: { mode: "pdf_crop", bbox_norm: [100, 50, 800, 700], padding_norm: 6 }
      }],
      caption_links: []
    }
  };
}

describe("applyMinerUVisualRepair same-page split caption projection", () => {
  it("joins and suppresses a uniquely image-bound formal caption and terminal continuation", () => {
    const input = samePageSplitCaptionFixture();
    const repaired = applyMinerUVisualRepair({
      visuals: input.visuals,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleMarkdown: input.articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });
    expect(repaired.visuals).toHaveLength(1);
    expect(repaired.visuals[0]).toMatchObject({
      captionText: `${input.formal} ${input.continuation}`,
      captionStatus: "complete",
      captionPageIndex: 0
    });
    expect(repaired.visuals[0].captionSourceRanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: input.formal }),
      expect.objectContaining({ text: input.continuation })
    ]));

    const projected = projectMinerUReaderMarkdown({
      markdown: input.articleMarkdown,
      visuals: repaired.visuals,
      viewerIndex: input.viewerIndex,
      articleHash,
      mineruHash
    });
    expect(projected.markdown).not.toContain(input.formal);
    expect(projected.markdown).not.toContain(input.continuation);
    expect(projected.markdown).not.toMatch(/^d\s*$/m);
    expect(projected.markdown).not.toMatch(/^e\s*$/m);
    expect(projected.markdown).toContain("Body remains.");
    expect(input.articleMarkdown).toContain(input.formal);
    expect(input.articleMarkdown).toContain(input.continuation);
  });

  it("preserves both caption fragments when the continuation is incomplete", () => {
    const input = samePageSplitCaptionFixture(false);
    const repaired = applyMinerUVisualRepair({
      visuals: input.visuals,
      viewerIndex: input.viewerIndex,
      visualRepair: input.visualRepair,
      articleMarkdown: input.articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });
    const projected = projectMinerUReaderMarkdown({
      markdown: input.articleMarkdown,
      visuals: repaired.visuals,
      viewerIndex: input.viewerIndex,
      articleHash,
      mineruHash
    });
    expect(projected.markdown).toContain(input.formal);
    expect(projected.markdown).toContain(input.continuation);
  });
});
