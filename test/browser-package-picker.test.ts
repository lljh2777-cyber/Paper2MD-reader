import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDirectPdfByteLength,
  BrowserPackagePicker,
  createDirectPdfDocument,
  DIRECT_PDF_PATH,
  MAX_DIRECT_PDF_BYTES
} from "../apps/web/src/browser-package-picker";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installDom(): Document {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
  return document;
}

afterEach(() => {
  Object.assign(globalThis, { document: originalDocument, window: originalWindow });
});

describe("BrowserPackagePicker PDF projection boundary", () => {
  it("omits every PDF projection capability in explicit read-only import mode", () => {
    const document = installDom();
    const picker = new BrowserPackagePicker({
      enableProcessingApi: false,
      allowPdfProjection: false
    });

    expect(picker.choosePdfPackage).toBeUndefined();
    expect(document.querySelector('input[accept*="application/pdf"]')).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(3);

    picker.dispose();
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("preserves the historical boolean constructor and local PDF projection default", () => {
    const document = installDom();
    const picker = new BrowserPackagePicker(false);

    expect(picker.choosePdfPackage).toBeTypeOf("function");
    expect(document.querySelectorAll("input")).toHaveLength(4);

    picker.dispose();
  });

  it("exposes direct PDF opening independently from PDF projection", async () => {
    const document = installDom();
    const picker = new BrowserPackagePicker({
      enableProcessingApi: false,
      allowPdfProjection: false,
      allowDirectPdfOpen: true
    });

    expect(picker.choosePdfDocument).toBeTypeOf("function");
    expect(picker.choosePdfPackage).toBeUndefined();
    expect(document.querySelector('input[data-reader-pdf-mode="direct"]')).not.toBeNull();
    expect(document.querySelector('input[data-reader-pdf-mode="projection"]')).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(4);

    const file = new File(["%PDF-1.7\nfixture"], "paper.pdf", { type: "application/octet-stream" });
    const selection = await createDirectPdfDocument(file);
    expect(selection.pdfPath).toBe(DIRECT_PDF_PATH);
    expect(selection.label).toBe("paper.pdf");
    expect(await selection.fileSystem.listFiles("_reader")).toEqual([DIRECT_PDF_PATH]);
    expect(await selection.fileSystem.exists("article.md")).toBe(false);
    expect(new TextDecoder().decode(await selection.fileSystem.readBinary(DIRECT_PDF_PATH))).toBe("%PDF-1.7\nfixture");
    selection.fileSystem.dispose();

    picker.dispose();
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("fails closed outside 5 B–64 MB or without a leading %PDF- signature", async () => {
    expect(() => assertDirectPdfByteLength(4)).toThrow(/between 5 bytes and 64 MB/);
    expect(() => assertDirectPdfByteLength(5)).not.toThrow();
    expect(() => assertDirectPdfByteLength(MAX_DIRECT_PDF_BYTES)).not.toThrow();
    expect(() => assertDirectPdfByteLength(MAX_DIRECT_PDF_BYTES + 1)).toThrow(/between 5 bytes and 64 MB/);
    await expect(createDirectPdfDocument(new File(["not-pdf"], "spoofed.pdf", { type: "application/pdf" })))
      .rejects.toThrow(/%PDF-/);
  });
});
