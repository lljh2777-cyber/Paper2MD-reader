import { describe, expect, it } from "vitest";
import { readerPageAtViewportTop, readerScrollTopForTarget } from "../src/sync/scroll-controller";

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

describe("readerScrollTopForTarget", () => {
  it("centers a target inside the article viewport without moving an ancestor", () => {
    expect(readerScrollTopForTarget({
      currentScrollTop: 600,
      containerTop: 100,
      containerHeight: 800,
      targetTop: 700,
      targetHeight: 40,
      maximumScrollTop: 4_000,
      block: "center"
    })).toBe(820);
  });

  it("clamps navigation to the article scroll range", () => {
    expect(readerScrollTopForTarget({
      currentScrollTop: 3_900,
      containerTop: 50,
      containerHeight: 900,
      targetTop: 1_500,
      targetHeight: 100,
      maximumScrollTop: 4_000,
      block: "start"
    })).toBe(4_000);
    expect(readerScrollTopForTarget({
      currentScrollTop: 20,
      containerTop: 200,
      containerHeight: 900,
      targetTop: 0,
      targetHeight: 20,
      maximumScrollTop: 4_000,
      block: "start"
    })).toBe(0);
  });
});
