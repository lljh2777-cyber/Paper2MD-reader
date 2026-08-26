import { describe, expect, it } from "vitest";
import { readerPageAtViewportTop } from "../src/sync/scroll-controller";

describe("readerPageAtViewportTop", () => {
  it("keeps a partially visible block as the page authority", () => {
    expect(readerPageAtViewportTop([
      { pageNumber: 2, top: -40, bottom: 45 },
      { pageNumber: 3, top: 45, bottom: 140 }
    ], 0, 100, 1)).toBe(2);
  });

  it("selects the first visible block and uses a bounded fallback", () => {
    expect(readerPageAtViewportTop([
      { pageNumber: 4, top: 120, bottom: 200 },
      { pageNumber: 5, top: 20, bottom: 100 }
    ], 0, 110, 3)).toBe(5);
    expect(readerPageAtViewportTop([], 0, 100, 3)).toBe(3);
  });
});
