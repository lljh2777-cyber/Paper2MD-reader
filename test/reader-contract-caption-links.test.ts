import { describe, expect, it } from "vitest";
import { buildMineruVisualRepair } from "../apps/processing-service/src/reader-contract-generator";

function viewerWithNextPageHeader(headerBbox: number[] = [62, 31, 147, 50]) {
  return {
    schema_version: 1,
    inputs: {
      article: { sha256: "article-hash" },
      mineru_result: { sha256: "mineru-hash" }
    },
    pages: [
      {
        page_idx: 32,
        blocks: [{
          id: "p0032-s000483",
          page_order: 0,
          role: "visual",
          asset_path: "images/extended-data-8.jpg",
          bbox_norm: [139, 59, 875, 889],
          caption: {
            next_page_marker: true,
            figure_keys: ["extended-data-figure:8"],
            next_page_figure_keys: ["extended-data-figure:8"]
          }
        }]
      },
      {
        page_idx: 33,
        blocks: [
          {
            id: "p0033-s000484",
            page_order: 0,
            role: "title",
            bbox_norm: headerBbox,
            text: {
              char_count: 7,
              leading_figure_key: null,
              leading_formal_figure_caption_key: null
            }
          },
          {
            id: "p0033-s000485",
            page_order: 1,
            role: "text",
            bbox_norm: [60, 56, 497, 225],
            text: {
              char_count: 985,
              leading_figure_key: "extended-data-figure:8",
              leading_formal_figure_caption_key: "extended-data-figure:8",
              starts_with_lowercase: false,
              starts_with_panel_label: false,
              ends_with_terminal_punctuation: false
            }
          },
          {
            id: "p0033-s000486",
            page_order: 2,
            role: "text",
            bbox_norm: [509, 59, 944, 212],
            text: {
              char_count: 874,
              leading_figure_key: null,
              leading_formal_figure_caption_key: null,
              starts_with_lowercase: true,
              starts_with_panel_label: false,
              ends_with_terminal_punctuation: true
            }
          }
        ]
      }
    ],
    markdown_images: []
  };
}

describe("MinerU cross-page caption links", () => {
  it("ignores a bounded running page header before a two-column formal caption", () => {
    const repair = buildMineruVisualRepair(viewerWithNextPageHeader()) as {
      caption_links: Array<Record<string, unknown>>;
      issues: Array<Record<string, unknown>>;
    };

    expect(repair.caption_links).toEqual([expect.objectContaining({
      visual_block_id: "p0032-s000483",
      caption_block_ids: ["p0033-s000485", "p0033-s000486"],
      figure_key: "extended-data-figure:8",
      status: "complete"
    })]);
    expect(repair.issues).toEqual([]);
  });

  it("does not skip a title outside the narrow running-header band", () => {
    const repair = buildMineruVisualRepair(viewerWithNextPageHeader([62, 80, 300, 115])) as {
      caption_links: unknown[];
      issues: Array<Record<string, unknown>>;
    };

    expect(repair.caption_links).toEqual([]);
    expect(repair.issues).toEqual([expect.objectContaining({
      code: "next_page_figure_caption_not_found",
      scan_boundary: "title_boundary"
    })]);
  });
});
