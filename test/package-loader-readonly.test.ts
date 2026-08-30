import { describe, expect, it } from "vitest";
import { PackageLoader } from "../src/model/package-loader";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

function rawMineruWithRecoverablePdfText(): MemoryReaderFileSystem {
  const sourceText = "The measured symbol � remains byte-identical in the raw MinerU result.";
  return new MemoryReaderFileSystem({
    "article.md": `# Raw MinerU paper\n\n${sourceText}\n`,
    "mineru-result.json": JSON.stringify([{
      type: "text",
      page_idx: 0,
      bbox: [80, 120, 920, 240],
      text: sourceText
    }]),
    "_extraction/source.pdf": new Uint8Array([37, 80, 68, 70, 45])
  });
}

describe("PackageLoader strict read-only mode", () => {
  it("keeps legacy runtime text recovery enabled by default", async () => {
    const loaded = await new PackageLoader(rawMineruWithRecoverablePdfText()).loadDetected();

    expect(loaded.textRecovery?.candidates).toHaveLength(1);
  });

  it("does not derive PDF text-recovery work for a raw MinerU package", async () => {
    const loaded = await new PackageLoader(rawMineruWithRecoverablePdfText(), {
      allowRuntimeTextRecovery: false
    }).loadDetected();

    expect(loaded.textRecovery).toBeUndefined();
    expect(loaded.articleText).toContain("symbol � remains byte-identical");
    expect(loaded.sourcePdf).toEqual({ path: "_extraction/source.pdf" });
  });
});
