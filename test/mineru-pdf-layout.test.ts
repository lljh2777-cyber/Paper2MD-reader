import { describe, expect, it } from "vitest";
import {
  buildMinerUPdfLayout,
  largeCompatibilityImageBlocks,
  sampledRegionLooksBlank
} from "../src/model/mineru-pdf-layout";

const hashes = { article: "a".repeat(64), mineru: "b".repeat(64) };
const viewer = {
  inputs: {
    article: { sha256: hashes.article },
    mineru_result: { sha256: hashes.mineru }
  },
  pages: [{
    page_idx: 0,
    blocks: [
      { id: "visual-1", role: "visual", source_type: "image", bbox_norm: [100, 100, 900, 700], asset_path: "images/a.png" },
      { id: "text-1", role: "text", source_type: "text", bbox_norm: [100, 750, 900, 900] },
      { id: "unsafe", role: "visual", source_type: "image", bbox_norm: [1, 1, 10, 10], asset_path: "../escape.png" }
    ]
  }]
};

describe("MinerU PDF layout projection", () => {
  it("exposes only normalized hash-bound blocks and unique visual ownership", () => {
    const layout = buildMinerUPdfLayout(viewer, [{ id: "figure-1", memberBlockIds: ["visual-1"] }], hashes.article, hashes.mineru);
    expect(layout?.blocks[0]).toEqual(expect.objectContaining({
      visualId: "figure-1",
      assetPath: "images/a.png",
      bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.6 }
    }));
    expect(layout?.blocks.find((block) => block.id === "unsafe")?.assetPath).toBeUndefined();
    expect(largeCompatibilityImageBlocks(layout, 1).map((block) => block.id)).toEqual(["visual-1"]);
  });

  it("fails closed for stale inputs and ambiguous visual ownership", () => {
    expect(buildMinerUPdfLayout(viewer, [], "stale", hashes.mineru)).toBeUndefined();
    const layout = buildMinerUPdfLayout(viewer, [
      { id: "a", memberBlockIds: ["visual-1"] },
      { id: "b", memberBlockIds: ["visual-1"] }
    ], hashes.article, hashes.mineru);
    expect(layout?.blocks[0].visualId).toBeUndefined();
  });

  it("detects a large blank region but not a region containing ink", () => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    const bbox = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    expect(sampledRegionLooksBlank(pixels, 100, 100, bbox)).toBe(true);
    for (let y = 10; y < 90; y += 1) {
      for (let x = 10; x < 90; x += 1) pixels[(y * 100 + x) * 4] = 0;
    }
    expect(sampledRegionLooksBlank(pixels, 100, 100, bbox)).toBe(false);
  });
});
