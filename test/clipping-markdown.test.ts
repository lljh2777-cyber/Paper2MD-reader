import { describe, expect, it } from "vitest";
import { adaptClippingMarkdown } from "../src/model/clipping-markdown";
import { PackageLoader } from "../src/model/package-loader";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

describe("Web Clipper Markdown adapter", () => {
  it("pairs local images with adjacent captions and adds display-only labels", () => {
    const source = `# Paper\n\n![](images/a.png)\n\nA caption without a Figure number.\n\nBody.\n\n![Figure 7](images/b.jpg)\n\nFigure 7. Explicit caption.\n`;
    const adapted = adaptClippingMarkdown(source);

    expect(adapted.visuals).toEqual([
      expect.objectContaining({ path: "images/a.png", label: "Fig. 1", captionText: "A caption without a Figure number." }),
      expect.objectContaining({ path: "images/b.jpg", label: "Fig. 7", captionText: "Figure 7. Explicit caption." })
    ]);
    expect(adapted.articleText).toContain('<!-- p2md:slot id="slot_000000000000000000000001" asset="ast_000000000000000000000001" -->');
    expect(adapted.articleText).toContain('<!-- p2md:block id="blk_000000000000000000000001" kind="caption" -->');
    expect(source).not.toContain("p2md:slot");
  });

  it("does not turn remote or traversal images into trusted Reader assets", () => {
    const adapted = adaptClippingMarkdown("![](https://example.com/a.png)\nCaption\n\n![](../outside.png)\nCaption");
    expect(adapted.visuals).toEqual([]);
    expect(adapted.articleText).not.toContain("p2md:slot");
  });

  it("removes Clipper frontmatter from the reading view without changing the input", () => {
    const source = "---\ntitle: Paper title\nsource: https://example.com/paper\n---\n# Paper title\n\nText.";
    const adapted = adaptClippingMarkdown(source);
    expect(adapted.articleText).toBe("# Paper title\n\nText.");
    expect(source).toContain("source: https://example.com/paper");
  });

  it("does not duplicate an existing Paper2MD anchor when the contract is missing", async () => {
    const source = '<!-- p2md:slot id="slot_111111111111111111111111" asset="ast_222222222222222222222222" -->\n![](images/plot.png)\n\nCaption.';
    const loaded = await new PackageLoader(new MemoryReaderFileSystem({
      "article.md": source,
      "images/plot.png": new Uint8Array([1])
    })).loadDetected();
    expect(loaded.state).toBe("reader-missing");
    expect(loaded.articleText.match(/p2md:slot/g)).toHaveLength(1);
  });

  it("loads paired clipping visuals as a distinct Markdown source", async () => {
    const source = "# Paper\n\n![](images/plot.png)\n\nMeasured response by group.\n";
    const fileSystem = new MemoryReaderFileSystem({
      "clip.md": source,
      "images/plot.png": new Uint8Array([1, 2, 3])
    });
    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.state).toBe("markdown");
    expect(loaded.sourceFormat).toBe("markdown");
    expect(loaded.assets).toEqual([expect.objectContaining({
      display_label: "Fig. 1",
      captionText: "Measured response by group.",
      exists: true
    })]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "markdown-display-pairing" }));
  });
});
