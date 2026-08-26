import { describe, expect, it } from "vitest";
import { DEFAULT_READER_VIEW_STATE, parseReaderViewState, readerViewStateKey } from "../src/sync/reader-view-state";

describe("reader view state", () => {
  it("accepts bounded sidecar state without touching a paper package", () => {
    expect(parseReaderViewState(JSON.stringify({
      version: 1,
      splitRatio: 0.74,
      articleScrollTop: 1234,
      referenceMode: "pdf",
      pdfPage: 8,
      pdfZoom: 1.5,
      pdfFollowing: false,
      showLayoutBoxes: false,
      selectedVisualId: "figure-8",
      visualFollowing: false
    }))).toEqual(expect.objectContaining({ splitRatio: 0.74, pdfPage: 8, selectedVisualId: "figure-8" }));
  });

  it("clamps numeric values and rejects malformed or obsolete state", () => {
    const state = parseReaderViewState(JSON.stringify({ version: 1, splitRatio: 2, pdfZoom: -4, pdfPage: -2 }));
    expect(state).toEqual(expect.objectContaining({ splitRatio: 0.78, pdfZoom: 0.4, pdfPage: 1 }));
    expect(parseReaderViewState("not-json")).toEqual(DEFAULT_READER_VIEW_STATE);
    expect(parseReaderViewState('{"version":0}')).toEqual(DEFAULT_READER_VIEW_STATE);
  });

  it("keys state only by a SHA-256 package identity", () => {
    expect(readerViewStateKey("a".repeat(64))).toBe(`paper2md-reader:view:v1:${"a".repeat(64)}`);
    expect(readerViewStateKey("paper-name")).toBeUndefined();
  });
});
