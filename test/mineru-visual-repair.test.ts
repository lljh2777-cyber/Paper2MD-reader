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
  it("consolidates multiple repair groups only when they exactly cover the page visuals", () => {
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

  it.each([
    ["forged body-text metadata", "Results from the next section are summarized here."],
    ["mismatched figure-key metadata", "Fig. 6. A complete caption for a different full-page figure."],
    ["forged terminal-punctuation metadata", "Fig. 5. A caption whose source text is not complete"]
  ])("does not trust %s for a next-page formal caption", (_label, sourceText) => {
    const input = fixture();
    const captionBlock = input.viewerIndex.pages[1].blocks[0];
    const sourceIndex = Number(captionBlock.source_index);
    input.raw[sourceIndex] = { ...input.raw[sourceIndex], text: sourceText } as never;
    input.articleMarkdown = input.articleMarkdown.replace(caption, sourceText);

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

  it("does not consolidate a full page when an edge visual is omitted from the repair groups", () => {
    const input = fixture();
    const edgePath = "images/edge.png";
    input.visuals.push({
      id: "ast_edge",
      kind: "figure",
      path: edgePath,
      label: "Figure 5",
      pageIndex: 0,
      placementBlockId: "slot_edge"
    });
    (input.viewerIndex.pages[0].blocks as Array<Record<string, unknown>>).push({
      id: "p0000-s000005",
      source_index: 5,
      page_order: 4,
      role: "visual",
      asset_path: edgePath,
      bbox_norm: [90, 40, 110, 60],
      markdown_image_ids: ["md-img-edge"],
      caption: {
        items: [{ text: "E", kind: "panel-label" }],
        formal_figure_caption_keys: [],
        next_page_marker: false
      },
      text: { formal_figure_caption_keys: [] }
    });
    input.raw.push({
      type: "image",
      page_idx: 0,
      bbox: [90, 40, 110, 60],
      img_path: edgePath,
      image_caption: ["E"]
    });

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

    expect(result.visuals).toHaveLength(3);
    expect(result.diagnostics.some((entry) => entry.code === "mineru-full-page-visual-consolidated")).toBe(false);
  });

  it("fails closed when the original MinerU payload is absent or empty", () => {
    for (const mineruPayload of [undefined, []]) {
      const input = fixture();
      const result = applyMinerUVisualRepair({
        visuals: input.visuals,
        viewerIndex: input.viewerIndex,
        visualRepair: input.visualRepair,
        mineruPayload,
        articleMarkdown: input.articleMarkdown,
        articleHash,
        mineruHash,
        sourcePdfPath: "_extraction/source.pdf"
      });

      expect(result.visuals).toEqual(input.visuals);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-viewer-source-binding-invalid" }));
    }
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

  it("fails closed when derived viewer block IDs are not globally unique", () => {
    const input = fixture();
    input.viewerIndex.pages[1].blocks[0].id = input.viewerIndex.pages[0].blocks[0].id;
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

    expect(result.visuals).toEqual(input.visuals);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-viewer-source-binding-invalid" }));
  });

  it("does not synthesize a full-page crop when a group path is not bound to its member blocks", () => {
    const input = fixture();
    input.visualRepair.groups[0].member_asset_paths = ["images/a.png", "images/c.png"];
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

    expect(result.visuals).toHaveLength(3);
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
  const raw = paths.map((path, index) => ({
    type: "image",
    page_idx: 0,
    bbox: blocks[index].bbox_norm,
    img_path: path,
    image_caption: index === 0
      ? ["d", "e"]
      : index === 1
        ? [formal]
        : index === 3
          ? [continuation]
          : []
  }));
  return {
    formal,
    continuation,
    articleMarkdown,
    visuals,
    raw,
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
      mineruPayload: input.raw,
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
      mineruPayload: input.raw,
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

describe("applyMinerUVisualRepair existing-package same-page recovery", () => {
  it("consolidates two column repair groups when they exactly cover one formally captioned page", () => {
    const paths = ["images/a.jpg", "images/b.jpg", "images/c.jpg", "images/d.jpg"];
    const formal = "Extended Data Fig. 1 | A complete multi-panel result. a, First. b, Second. c, Third. d, Fourth.";
    const articleMarkdown = `${paths.map((path) => `![](${path})`).join("\n\n")}\n\n${formal}\n`;
    const imageEntries = paths.map((path, index) => {
      const token = `![](${path})`;
      const start = articleMarkdown.indexOf(token);
      return { id: `md-${index}`, asset_path: path, char_start: start, char_end: start + token.length };
    });
    const blocks = paths.map((path, index) => ({
      id: `visual-${index}`,
      source_index: index,
      page_order: index + 1,
      role: "visual",
      asset_path: path,
      bbox_norm: index < 2
        ? [70, 60 + index * 280, 490, 330 + index * 280]
        : [510, 60 + (index - 2) * 280, 930, 330 + (index - 2) * 280],
      markdown_image_ids: [`md-${index}`],
      text: {},
      caption: { items: [{ text: String.fromCharCode(97 + index), kind: "panel-label" }] }
    }));
    const captionBlock = {
      id: "caption-1",
      source_index: 5,
      page_order: 5,
      role: "text",
      bbox_norm: [60, 630, 940, 820],
      text: {
        leading_figure_key: "extended-data-figure:1",
        leading_formal_figure_caption_key: "extended-data-figure:1",
        ends_with_terminal_punctuation: true
      },
      caption: { items: [] }
    };
    const visuals: MinerUVisual[] = paths.map((path, index) => ({
      id: `asset-${index}`,
      kind: "figure",
      path,
      label: `Figure ${index + 1}`,
      pageIndex: 21,
      placementBlockId: `slot-${index}`
    }));
    const viewerIndex = {
      schema_version: 1,
      inputs: contractInputs(),
      markdown_images: imageEntries,
      pages: [{
        page_idx: 21,
        blocks: [
          { id: "header", source_index: 4, page_order: 0, role: "title", bbox_norm: [63, 31, 146, 50], text: { char_count: 7 }, caption: { items: [] } },
          ...blocks,
          captionBlock
        ]
      }]
    };
    const visualRepair = {
      schema_version: 1,
      inputs: contractInputs(),
      groups: [
        {
          id: "left",
          page_idx: 21,
          member_block_ids: ["visual-0", "visual-1"],
          member_asset_paths: paths.slice(0, 2),
          member_markdown_image_ids: ["md-0", "md-1"],
          decision: "auto",
          confidence: 0.99,
          replacement: { mode: "pdf_crop", bbox_norm: [70, 60, 490, 610], padding_norm: 6 }
        },
        {
          id: "right",
          page_idx: 21,
          member_block_ids: ["visual-2", "visual-3"],
          member_asset_paths: paths.slice(2),
          member_markdown_image_ids: ["md-2", "md-3"],
          decision: "auto",
          confidence: 0.95,
          replacement: { mode: "pdf_crop", bbox_norm: [510, 60, 930, 610], padding_norm: 6 }
        }
      ],
      caption_links: []
    };
    const mineruPayload = [
      ...paths.map((path, index) => ({ type: "image", page_idx: 21, bbox: blocks[index].bbox_norm, img_path: path })),
      { type: "text", text_level: 2, page_idx: 21, bbox: [63, 31, 146, 50], text: "Article" },
      { type: "text", page_idx: 21, bbox: [60, 630, 940, 820], text: formal }
    ];
    const result = applyMinerUVisualRepair({
      visuals,
      viewerIndex,
      visualRepair,
      mineruPayload,
      articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(result.visuals).toHaveLength(1);
    expect(result.visuals[0]).toMatchObject({
      label: "Extended Data Fig. 1",
      captionText: formal,
      captionStatus: "complete",
      captionPageIndex: 21,
      memberBlockIds: ["visual-0", "visual-1", "visual-2", "visual-3"],
      display: { mode: "pdf-crop", bbox: { x: 0.07, y: 0.06, width: 0.86, height: 0.55 } }
    });

    const viewerWithUnboundTable = structuredClone(viewerIndex);
    (viewerWithUnboundTable.pages[0].blocks as Array<Record<string, unknown>>).push({
      id: "orphan-table",
      source_index: 6,
      page_order: 6,
      role: "table",
      bbox_norm: [70, 830, 930, 920],
      markdown_image_ids: [],
      text: {},
      caption: { items: [] }
    });
    const ambiguous = applyMinerUVisualRepair({
      visuals,
      viewerIndex: viewerWithUnboundTable,
      visualRepair,
      mineruPayload: [
        ...mineruPayload,
        { type: "table", page_idx: 21, bbox: [70, 830, 930, 920] }
      ],
      articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });
    expect(ambiguous.visuals).toHaveLength(2);
    expect(ambiguous.diagnostics.some((entry) => entry.code === "mineru-full-page-visual-consolidated")).toBe(false);
  });

  it("joins a source-confirmed caption and rejects forged lowercase or terminal summaries", () => {
    const path = "images/extended-data-2.jpg";
    const anchor = "Extended Data Fig. 2 | DeepMet results. a, First result. b, Second result. e, Heatmap showing the proportion of";
    const continuation = "generated metabolites found in the held-out set. f, Final result.";
    const token = `![](${path})`;
    const articleMarkdown = `b\n\n${token}\n\n${anchor}\n\n${continuation}\n`;
    const imageStart = articleMarkdown.indexOf(token);
    const visuals: MinerUVisual[] = [{ id: "asset-ed2", kind: "figure", path, label: "Figure 63", pageIndex: 22, placementBlockId: "slot-ed2" }];
    const viewerIndex = {
      schema_version: 1,
      inputs: contractInputs(),
      markdown_images: [{ id: "md-ed2", asset_path: path, char_start: imageStart, char_end: imageStart + token.length }],
      pages: [{ page_idx: 22, blocks: [
        {
          id: "visual-ed2", source_index: 0, page_order: 0, role: "visual", asset_path: path,
          bbox_norm: [82, 65, 936, 725], markdown_image_ids: ["md-ed2"], text: {},
          caption: { items: [{ text: "b", kind: "panel-label" }] }
        },
        {
          id: "caption-ed2-a", source_index: 1, page_order: 1, role: "text", bbox_norm: [60, 735, 497, 878],
          text: { leading_figure_key: "extended-data-figure:2", leading_formal_figure_caption_key: "extended-data-figure:2", ends_with_terminal_punctuation: false }, caption: { items: [] }
        },
        {
          id: "caption-ed2-b", source_index: 2, page_order: 2, role: "text", bbox_norm: [507, 735, 939, 865],
          text: { starts_with_lowercase: true, starts_with_panel_label: false, ends_with_terminal_punctuation: true }, caption: { items: [] }
        }
      ] }]
    };
    const visualRepair = { schema_version: 1, inputs: contractInputs(), groups: [], caption_links: [] };
    const mineruPayload = [
      { type: "image", page_idx: 22, bbox: [82, 65, 936, 725], img_path: path, image_caption: ["b"] },
      { type: "text", page_idx: 22, bbox: [60, 735, 497, 878], text: anchor },
      { type: "text", page_idx: 22, bbox: [507, 735, 939, 865], text: continuation }
    ];
    const result = applyMinerUVisualRepair({
      visuals,
      viewerIndex,
      visualRepair,
      mineruPayload,
      articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(result.visuals[0]).toMatchObject({
      label: "Extended Data Fig. 2",
      captionText: `${anchor} ${continuation}`,
      captionStatus: "complete",
      captionPageIndex: 22
    });
    expect(result.visuals[0].captionSourceRanges).toHaveLength(3);
    const projected = projectMinerUReaderMarkdown({
      markdown: articleMarkdown,
      visuals: result.visuals,
      viewerIndex: {
        schema_version: 1,
        inputs: contractInputs(),
        markdown_images: [{ id: "md-ed2", asset_path: path, char_start: imageStart, char_end: imageStart + token.length }]
      },
      articleHash,
      mineruHash
    });
    expect(projected.markdown).not.toContain(anchor);
    expect(projected.markdown).not.toContain(continuation);
    expect(projected.markdown).not.toMatch(/^b\s*$/m);

    const unrelated = "Results from an unrelated paragraph end here.";
    const forged = applyMinerUVisualRepair({
      visuals,
      viewerIndex,
      visualRepair,
      mineruPayload: [
        mineruPayload[0],
        mineruPayload[1],
        { ...mineruPayload[2], text: unrelated }
      ],
      articleMarkdown: articleMarkdown.replace(continuation, unrelated),
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });
    expect(forged.visuals[0].captionStatus).toBeUndefined();
    expect(forged.visuals[0].captionText).not.toContain(unrelated);

    const unterminated = "generated metabolites continue without a verified ending";
    const forgedTerminal = applyMinerUVisualRepair({
      visuals,
      viewerIndex,
      visualRepair,
      mineruPayload: [
        mineruPayload[0],
        mineruPayload[1],
        { ...mineruPayload[2], text: unterminated }
      ],
      articleMarkdown: articleMarkdown.replace(continuation, unterminated),
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });
    expect(forgedTerminal.visuals[0].captionStatus).toBeUndefined();
    expect(forgedTerminal.visuals[0].captionText).not.toContain(unterminated);
  });

  it("hides only a uniquely adjacent Creative Commons footer badge from visual navigation", () => {
    const path = "images/cc-badge.jpg";
    const license = "Open Access This article is licensed under a Creative Commons licence. See https://creativecommons.org/licenses/by-nc-nd/4.0/";
    const token = `![](${path})`;
    const articleMarkdown = `${token}\n\n${license}\n`;
    const result = applyMinerUVisualRepair({
      visuals: [{ id: "badge", kind: "figure", path, label: "Figure 53", pageIndex: 9, placementBlockId: "slot-badge" }],
      viewerIndex: {
        schema_version: 1,
        inputs: contractInputs(),
        markdown_images: [{ id: "md-badge", asset_path: path, char_start: 0, char_end: token.length }],
        pages: [{ page_idx: 9, blocks: [
          { id: "badge-block", source_index: 0, page_order: 0, role: "visual", asset_path: path, bbox_norm: [512, 751, 583, 772], markdown_image_ids: ["md-badge"], text: {}, caption: { items: [] } },
          { id: "license-block", source_index: 1, page_order: 1, role: "text", bbox_norm: [584, 750, 939, 781], markdown_image_ids: [], text: {}, caption: { items: [] } }
        ] }]
      },
      visualRepair: { schema_version: 1, inputs: contractInputs(), groups: [], caption_links: [] },
      mineruPayload: [
        { type: "image", page_idx: 9, bbox: [512, 751, 583, 772], img_path: path },
        { type: "text", page_idx: 9, bbox: [584, 750, 939, 781], text: license }
      ],
      articleMarkdown,
      articleHash,
      mineruHash
    });

    expect(result.visuals[0].hidden).toBe(true);
    expect(result.diagnostics.some((entry) => entry.code === "mineru-footer-badge-suppressed")).toBe(true);
    const projected = projectMinerUReaderMarkdown({
      markdown: articleMarkdown,
      visuals: result.visuals,
      viewerIndex: {
        schema_version: 1,
        inputs: contractInputs(),
        markdown_images: [{ id: "md-badge", asset_path: path, char_start: 0, char_end: token.length }]
      },
      articleHash,
      mineruHash
    });
    expect(projected.markdown).toBe(articleMarkdown);

    const noLicense = applyMinerUVisualRepair({
      visuals: [{ id: "badge", kind: "figure", path, label: "Figure 53", pageIndex: 9, placementBlockId: "slot-badge" }],
      viewerIndex: {
        schema_version: 1,
        inputs: contractInputs(),
        markdown_images: [{ id: "md-badge", asset_path: path, char_start: 0, char_end: token.length }],
        pages: [{ page_idx: 9, blocks: [{ id: "badge-block", source_index: 0, page_order: 0, role: "visual", asset_path: path, bbox_norm: [512, 751, 583, 772], markdown_image_ids: ["md-badge"], text: {}, caption: { items: [] } }] }]
      },
      visualRepair: { schema_version: 1, inputs: contractInputs(), groups: [], caption_links: [] },
      mineruPayload: [{ type: "image", page_idx: 9, bbox: [512, 751, 583, 772], img_path: path }],
      articleMarkdown,
      articleHash,
      mineruHash
    });
    expect(noLicense.visuals[0].hidden).not.toBe(true);
  });

  it("hides unplaced publisher reporting-form tables only after an exact form boundary", () => {
    const path = "images/reporting-form-table.jpg";
    const viewerIndex = {
      schema_version: 1,
      inputs: contractInputs(),
      pages: [
        { page_idx: 36, blocks: [
          { id: "publisher", source_index: 0, page_order: 0, role: "title", bbox_norm: [32, 41, 408, 90], text: {}, caption: { items: [] } },
          { id: "summary", source_index: 1, page_order: 1, role: "title", bbox_norm: [37, 156, 326, 183], text: {}, caption: { items: [] } },
          { id: "reporting-signature-1", source_index: 2, page_order: 2, role: "marginalia", bbox_norm: [939, 35, 960, 248], text: {}, caption: { items: [] } }
        ] },
        { page_idx: 37, blocks: [
          { id: "form-table", source_index: 3, page_order: 0, role: "table", asset_path: path, bbox_norm: [40, 127, 913, 349], markdown_image_ids: [], text: {}, caption: { items: [] } },
          { id: "reporting-signature-2", source_index: 4, page_order: 1, role: "marginalia", bbox_norm: [939, 35, 960, 248], text: {}, caption: { items: [] } }
        ] }
      ]
    };
    const base = {
      visuals: [{ id: "form-asset", kind: "table" as const, path, label: "Table 144", pageIndex: 37 }],
      viewerIndex,
      visualRepair: { schema_version: 1, inputs: contractInputs(), groups: [], caption_links: [] },
      mineruPayload: [
        { type: "text", text_level: 1, page_idx: 36, bbox: [32, 41, 408, 90], text: "natureportfolio" },
        { type: "text", text_level: 2, page_idx: 36, bbox: [37, 156, 326, 183], text: "Reporting Summary" },
        { type: "aside_text", page_idx: 36, bbox: [939, 35, 960, 248], text: "nature portfolio | reporting summary" },
        { type: "table", page_idx: 37, bbox: [40, 127, 913, 349], img_path: path },
        { type: "aside_text", page_idx: 37, bbox: [939, 35, 960, 248], text: "nature portfolio | reporting summary" }
      ],
      articleHash,
      mineruHash
    };
    const result = applyMinerUVisualRepair(base);
    expect(result.visuals[0].hidden).toBe(true);
    expect(result.diagnostics.some((entry) => entry.code === "mineru-reporting-form-visuals-suppressed")).toBe(true);

    const withoutBoundary = applyMinerUVisualRepair({
      ...base,
      mineruPayload: [
        { type: "text", text_level: 1, page_idx: 36, bbox: [32, 41, 408, 90], text: "Publisher" },
        { type: "text", text_level: 2, page_idx: 36, bbox: [37, 156, 326, 183], text: "Reporting Summary" },
        { type: "aside_text", page_idx: 36, bbox: [939, 35, 960, 248], text: "nature portfolio | reporting summary" },
        { type: "table", page_idx: 37, bbox: [40, 127, 913, 349], img_path: path },
        { type: "aside_text", page_idx: 37, bbox: [939, 35, 960, 248], text: "nature portfolio | reporting summary" }
      ]
    });
    expect(withoutBoundary.visuals[0].hidden).not.toBe(true);

    const wrongVisualPage = applyMinerUVisualRepair({
      ...base,
      visuals: [{ ...base.visuals[0], pageIndex: 38 }]
    });
    expect(wrongVisualPage.visuals[0].hidden).not.toBe(true);
  });
});

describe("applyMinerUVisualRepair next-page running-header recovery", () => {
  it("restores a complete two-column caption for an existing package whose contract stopped at a running header", () => {
    const imagePath = "images/extended-data-8.jpg";
    const placeholder = "Extended Data Fig. 8 | See next page for caption.";
    const anchor = "Extended Data Fig. 8 | Examples of incorrect predictions. a, The first comparison ends with the standard";
    const continuation = "affords a partial match. b, The second comparison. c, The third comparison. d, The fourth comparison. e, The fifth comparison. f, The sixth comparison. g, The final comparison.";
    const articleMarkdown = `# Paper\n\n![](${imagePath})\n\n${placeholder}\n\n${anchor}\n\n${continuation}\n\nBody remains.\n`;
    const imageToken = `![](${imagePath})`;
    const imageStart = articleMarkdown.indexOf(imageToken);
    const visual: MinerUVisual = {
      id: "ast-extended-8",
      kind: "figure",
      path: imagePath,
      label: "Extended Data Fig. 8",
      captionText: placeholder,
      pageIndex: 32,
      placementBlockId: "slot-extended-8"
    };
    const viewerIndex = {
      schema_version: 1,
      inputs: contractInputs(),
      markdown_images: [{
        id: "md-img-extended-8",
        asset_path: imagePath,
        char_start: imageStart,
        char_end: imageStart + imageToken.length
      }],
      pages: [
        {
          page_idx: 32,
          blocks: [{
            id: "p0032-s000000",
            source_index: 0,
            page_order: 0,
            role: "visual",
            asset_path: imagePath,
            bbox_norm: [139, 59, 875, 889],
            markdown_image_ids: ["md-img-extended-8"],
            caption: {
              items: [{ text: placeholder, kind: "next-page-placeholder" }],
              next_page_marker: true,
              next_page_figure_keys: ["extended-data-figure:8"]
            },
            text: {}
          }]
        },
        {
          page_idx: 33,
          blocks: [
            {
              id: "p0033-s000001",
              source_index: 1,
              page_order: 0,
              role: "title",
              bbox_norm: [62, 31, 147, 50],
              text: { char_count: 7, leading_figure_key: null, leading_formal_figure_caption_key: null }
            },
            {
              id: "p0033-s000002",
              source_index: 2,
              page_order: 1,
              role: "text",
              bbox_norm: [60, 56, 497, 225],
              text: {
                char_count: anchor.length,
                leading_figure_key: "extended-data-figure:8",
                leading_formal_figure_caption_key: "extended-data-figure:8",
                starts_with_lowercase: false,
                starts_with_panel_label: false,
                ends_with_terminal_punctuation: false
              }
            },
            {
              id: "p0033-s000003",
              source_index: 3,
              page_order: 2,
              role: "text",
              bbox_norm: [509, 59, 944, 212],
              text: {
                char_count: continuation.length,
                leading_figure_key: null,
                leading_formal_figure_caption_key: null,
                starts_with_lowercase: true,
                starts_with_panel_label: false,
                ends_with_terminal_punctuation: true
              }
            }
          ]
        }
      ]
    };
    const result = applyMinerUVisualRepair({
      visuals: [visual],
      viewerIndex,
      visualRepair: { schema_version: 1, inputs: contractInputs(), groups: [], caption_links: [] },
      mineruPayload: [
        { type: "chart", page_idx: 32, bbox: [139, 59, 875, 889], img_path: imagePath, chart_caption: [placeholder] },
        { type: "text", text_level: 2, page_idx: 33, bbox: [62, 31, 147, 50], text: "Article" },
        { type: "text", page_idx: 33, bbox: [60, 56, 497, 225], text: anchor },
        { type: "text", page_idx: 33, bbox: [509, 59, 944, 212], text: continuation }
      ],
      articleMarkdown,
      articleHash,
      mineruHash,
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(result.visuals[0]).toMatchObject({
      captionText: `${anchor} ${continuation}`,
      captionPageIndex: 33,
      captionStatus: "complete"
    });
    const projected = projectMinerUReaderMarkdown({
      markdown: articleMarkdown,
      visuals: result.visuals,
      viewerIndex,
      articleHash,
      mineruHash
    });
    expect(projected.markdown).not.toContain(placeholder);
    expect(projected.markdown).not.toContain(anchor);
    expect(projected.markdown).not.toContain(continuation);
    expect(projected.markdown).toContain("Body remains.");
  });
});
