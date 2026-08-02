import {
  BLOCK_FINGERPRINT_VERSION,
  MARKDOWN_ANCHOR_CONTRACT_VERSION,
  ReaderContract,
  READER_CONTRACT_VERSION
} from "../src/model/reader-contract";

export const IDS = {
  title: "blk_111111111111111111111111",
  body: "blk_222222222222222222222222",
  asset: "ast_333333333333333333333333",
  slot: "slot_444444444444444444444444",
  caption: "blk_555555555555555555555555",
  places: "rel_666666666666666666666666",
  captionOf: "rel_777777777777777777777777"
} as const;

export const HASHES = {
  source: "a".repeat(64),
  article: "b".repeat(64),
  asset: "c".repeat(64),
  reader: "d".repeat(64),
  elements: "e".repeat(64),
  text: "f".repeat(64)
} as const;

const span = {
  page_index: 0,
  bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
  region_id: "region-1",
  paragraph_index: 0,
  elements_sha256: HASHES.elements
};

function fingerprint(textLength: number) {
  return {
    visible_text_sha256: HASHES.text,
    simhash64: "0123456789abcdef",
    text_length: textLength
  };
}

export function makeContract(): ReaderContract {
  return {
    contract_version: READER_CONTRACT_VERSION,
    source_sha256: HASHES.source,
    article: {
      path: "article.md",
      sha256: HASHES.article,
      anchor_contract: MARKDOWN_ANCHOR_CONTRACT_VERSION,
      block_fingerprint_version: BLOCK_FINGERPRINT_VERSION
    },
    capabilities: {
      layout_semantics: "reviewed",
      caption_binding: "reviewed-layout-geometry",
      body_references: "unavailable"
    },
    blocks: [
      {
        id: IDS.title,
        kind: "title",
        order: 1,
        anchor: { syntax: "p2md:block", id: IDS.title },
        fingerprint: fingerprint(11),
        source_spans: [span],
        asset_id: null
      },
      {
        id: IDS.body,
        kind: "body",
        order: 2,
        anchor: { syntax: "p2md:block", id: IDS.body },
        fingerprint: fingerprint(19),
        source_spans: [span],
        asset_id: null
      },
      {
        id: IDS.slot,
        kind: "visual_slot",
        order: 3,
        anchor: { syntax: "p2md:slot", id: IDS.slot },
        fingerprint: fingerprint(0),
        source_spans: [span],
        asset_id: IDS.asset
      },
      {
        id: IDS.caption,
        kind: "caption",
        order: 4,
        anchor: { syntax: "p2md:block", id: IDS.caption },
        fingerprint: fingerprint(24),
        source_spans: [span],
        asset_id: null
      }
    ],
    assets: [
      {
        id: IDS.asset,
        kind: "figure",
        path: "images/figure-0001.png",
        sha256: HASHES.asset,
        size_bytes: 1024,
        width_px: 800,
        height_px: 600,
        display_label: "Figure 1",
        caption_block_id: IDS.caption,
        placement_block_id: IDS.slot,
        source_spans: [span]
      }
    ],
    relations: [
      {
        id: IDS.places,
        type: "places",
        source_id: IDS.slot,
        target_id: IDS.asset,
        label: null
      },
      {
        id: IDS.captionOf,
        type: "caption-of",
        source_id: IDS.caption,
        target_id: IDS.asset,
        label: "Figure 1"
      }
    ]
  };
}

export function makeArticle(): string {
  return [
    `<!-- p2md:block id="${IDS.title}" kind="title" -->`,
    "# Paper title",
    "",
    `<!-- p2md:block id="${IDS.body}" kind="body" -->`,
    "A body paragraph.",
    "",
    `<!-- p2md:slot id="${IDS.slot}" asset="${IDS.asset}" -->`,
    "![Figure 1](images/figure-0001.png)",
    "",
    `<!-- p2md:block id="${IDS.caption}" kind="caption" -->`,
    "**Figure 1.** Caption."
  ].join("\n");
}

export function cloneContract(): ReaderContract {
  return JSON.parse(JSON.stringify(makeContract())) as ReaderContract;
}
