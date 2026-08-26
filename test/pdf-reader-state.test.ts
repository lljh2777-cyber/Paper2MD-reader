import { describe, expect, it } from "vitest";
import { PDF_MAX_ZOOM, PDF_MIN_ZOOM, PdfReaderState } from "../src/sync/pdf-reader-state";

describe("PdfReaderState", () => {
  it("clamps pages to the loaded document", () => {
    const state = new PdfReaderState();
    state.setPageCount(8);
    state.setPage(12);
    expect(state.currentPage).toBe(8);
    state.changePage(-20);
    expect(state.currentPage).toBe(1);
  });

  it("clamps an existing page when a shorter PDF replaces the document", () => {
    const state = new PdfReaderState();
    state.setPageCount(20);
    state.setPage(18);
    state.setPageCount(4);
    expect(state.currentPage).toBe(4);
  });

  it("keeps zoom inside the reader safety range", () => {
    const state = new PdfReaderState();
    state.setZoom(100);
    expect(state.zoom).toBe(PDF_MAX_ZOOM);
    state.setZoom(0);
    expect(state.zoom).toBe(PDF_MIN_ZOOM);
    state.setZoom(1);
    state.changeZoom(1.15);
    expect(state.zoom).toBeCloseTo(1.15);
  });
});
