import { describe, expect, it } from "vitest";
import { partitionPackageManifestFiles } from "../apps/processing-service/src/package-publisher";

function entry(path: string) {
  return { path, size: 1, sha256: "0".repeat(64) };
}

describe("package manifest partitioning", () => {
  it("keeps deterministic Reader contracts separate from immutable extraction outputs", () => {
    const result = partitionPackageManifestFiles([
      entry("article.md"),
      entry("mineru-result.json"),
      entry("images/figure.png"),
      entry("_extraction/viewer-index.json"),
      entry("_extraction/visual-repair.json"),
      entry("_extraction/visual-candidates.json")
    ]);

    expect(result.outputs.map((item) => item.path)).toEqual([
      "article.md",
      "mineru-result.json",
      "images/figure.png"
    ]);
    expect(result.derivedContracts.map((item) => item.path)).toEqual([
      "_extraction/viewer-index.json",
      "_extraction/visual-repair.json",
      "_extraction/visual-candidates.json"
    ]);
  });

  it("fails closed when any required Reader contract is missing", () => {
    expect(() => partitionPackageManifestFiles([
      entry("article.md"),
      entry("_extraction/viewer-index.json"),
      entry("_extraction/visual-repair.json")
    ])).toThrow("Reader derived contract set is incomplete");
    expect(() => partitionPackageManifestFiles([
      entry("_extraction/viewer-index.json"),
      entry("_extraction/viewer-index.json"),
      entry("_extraction/visual-repair.json")
    ])).toThrow("Reader derived contract set is incomplete");
  });
});
