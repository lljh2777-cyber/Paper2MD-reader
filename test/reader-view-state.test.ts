import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_VIEW_STATE,
  parseReaderViewState,
  READER_VIEW_STATE_VERSION,
  readerViewStateKey
} from "../src/sync/reader-view-state";

describe("reader view state", () => {
  it("accepts bounded sidecar state without touching a paper package", () => {
    expect(parseReaderViewState(JSON.stringify({
      version: READER_VIEW_STATE_VERSION,
      splitRatio: 0.74,
      articleScrollTop: 1234,
      articleAnchor: {
        targetId: "methods",
        label: "Methods",
        level: 2,
        sectionProgress: 0.35
      },
      referenceMode: "pdf",
      pdfPage: 8,
      pdfZoom: 1.5,
      pdfFollowing: false,
      showLayoutBoxes: false,
      selectedVisualId: "figure-8",
      visualFollowing: false
    }))).toEqual(expect.objectContaining({
      splitRatio: 0.74,
      articleScrollTop: 1234,
      articleAnchor: { targetId: "methods", label: "Methods", level: 2, sectionProgress: 0.35 },
      pdfPage: 8,
      selectedVisualId: "figure-8"
    }));
  });

  it("clamps numeric values and rejects malformed or obsolete state", () => {
    const state = parseReaderViewState(JSON.stringify({ version: READER_VIEW_STATE_VERSION, splitRatio: 2, pdfZoom: -4, pdfPage: -2 }));
    expect(state).toEqual(expect.objectContaining({ splitRatio: 0.78, pdfZoom: 0.4, pdfPage: 1 }));
    expect(parseReaderViewState("not-json")).toEqual(DEFAULT_READER_VIEW_STATE);
    expect(parseReaderViewState('{"version":99}')).toEqual(DEFAULT_READER_VIEW_STATE);
  });

  it("migrates v1 settings without trusting their absolute article pixel", () => {
    expect(parseReaderViewState(JSON.stringify({
      version: 1,
      splitRatio: 0.7,
      articleScrollTop: 25000,
      referenceMode: "pdf",
      pdfPage: 7
    }))).toEqual(expect.objectContaining({
      version: READER_VIEW_STATE_VERSION,
      splitRatio: 0.7,
      articleScrollTop: 0,
      articleAnchor: undefined,
      referenceMode: "pdf",
      pdfPage: 7
    }));
  });

  it("drops malformed anchors and makes their pixel fallback unusable", () => {
    expect(parseReaderViewState(JSON.stringify({
      version: READER_VIEW_STATE_VERSION,
      articleScrollTop: 9000,
      articleAnchor: { targetId: "methods", label: "Methods", level: 8, sectionProgress: 2 }
    }))).toEqual(expect.objectContaining({ articleScrollTop: 0, articleAnchor: undefined }));
  });

  it("keys state only by a SHA-256 package identity", () => {
    expect(readerViewStateKey("a".repeat(64))).toBe(`paper2md-reader:view:v1:${"a".repeat(64)}`);
    expect(readerViewStateKey("paper-name")).toBeUndefined();
  });
});
