import { describe, expect, it } from "vitest";
import { buildMinerUPageMap, injectMinerUPageAnchors } from "../src/model/mineru-page-map";

describe("MinerU page map", () => {
  it("injects monotonic display-only page anchors from unique source blocks", () => {
    const source = "# Paper\n\nFirst page paragraph.\n\nSecond page paragraph.\n\nThird page paragraph.\n";
    const payload = [
      { type: "text", page_idx: 0, text: "First page paragraph." },
      { type: "text", page_idx: 1, text: "Second page paragraph." },
      { type: "text", page_idx: 2, text: "Third page paragraph." }
    ];
    const viewer = {
      pages: payload.map((_, index) => ({
        page_idx: index,
        blocks: [{ source_index: index, page_order: 0 }]
      }))
    };
    const map = buildMinerUPageMap(source, payload, viewer);
    const projected = injectMinerUPageAnchors(source, map);
    expect(map?.pageCount).toBe(3);
    expect(projected.match(/data-p2md-page=/g)).toHaveLength(3);
    expect(projected.indexOf('data-p2md-page="1"')).toBeLessThan(projected.indexOf('data-p2md-page="2"'));
    expect(projected.indexOf('data-p2md-page="2"')).toBeLessThan(projected.indexOf('data-p2md-page="3"'));
    expect(source).not.toContain("p2md-page-anchor");
  });

  it("does not map a repeated source block", () => {
    const source = "# Paper\n\nRepeated paragraph.\n\nRepeated paragraph.\n";
    const payload = [{ type: "text", page_idx: 1, text: "Repeated paragraph." }];
    const map = buildMinerUPageMap(source, payload, {
      pages: [{ page_idx: 1, blocks: [{ source_index: 0, page_order: 0 }] }]
    });
    expect(map?.boundaries[0].candidates).toEqual([]);
    expect(injectMinerUPageAnchors(source, map)).toBe(source);
  });
});
