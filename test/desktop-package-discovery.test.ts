import { describe, expect, it } from "vitest";
import { selectSourcePdfName } from "../apps/desktop/src/main/package-discovery";

describe("desktop package PDF discovery", () => {
  it("selects the UUID-named MinerU origin PDF", () => {
    expect(selectSourcePdfName([
      "full.md",
      "b252db0a-e453-4514-83de-226ea2fb9b02_origin.pdf",
      "supplement.pdf"
    ])).toBe("b252db0a-e453-4514-83de-226ea2fb9b02_origin.pdf");
  });

  it("accepts a single PDF and rejects ambiguous PDF folders", () => {
    expect(selectSourcePdfName(["paper.pdf"])).toBe("paper.pdf");
    expect(selectSourcePdfName(["paper.pdf", "supplement.pdf"])).toBeUndefined();
  });
});
