import { describe, expect, it } from "vitest";
import { projectMinerUReaderMarkdown } from "../src/model/mineru-reader-projection";
import { RepairedMinerUVisual } from "../src/model/mineru-visual-repair";

function imageEntry(markdown: string, id: string, path: string) {
  const token = `![](${path})`;
  const start = markdown.indexOf(token);
  return { id, asset_path: path, char_start: start, char_end: start + token.length };
}

function visual(overrides: Partial<RepairedMinerUVisual> = {}): RepairedMinerUVisual {
  return {
    id: "vr-p0000-g0000",
    kind: "figure",
    path: "images/a.png",
    label: "Figure 1",
    captionText: "Figure 1. Exact formal caption.",
    pageIndex: 0,
    placementBlockId: "slot_000000000000000000000001",
    memberAssetPaths: ["images/a.png", "images/b.png"],
    memberMarkdownImageIds: ["md-img-0000", "md-img-0001"],
    panelLabels: ["A"],
    ...overrides
  };
}

describe("MinerU Reader display projection", () => {
  it("replaces verified fragment image occurrences with one anchor and suppresses the exact caption", () => {
    const markdown = [
      "# Paper",
      "",
      "A  ",
      "![](images/a.png)",
      "",
      "![](images/b.png)",
      "Figure 1. Exact formal caption.",
      "",
      "Body remains."
    ].join("\n");
    const viewerIndex = {
      schema_version: 1,
      inputs: { article: { sha256: "article" }, mineru_result: { sha256: "mineru" } },
      markdown_images: [
        imageEntry(markdown, "md-img-0000", "images/a.png"),
        imageEntry(markdown, "md-img-0001", "images/b.png")
      ]
    };

    const projected = projectMinerUReaderMarkdown({
      markdown,
      visuals: [visual()],
      viewerIndex,
      articleHash: "article",
      mineruHash: "mineru"
    });

    expect(markdown).toContain("![](images/a.png)");
    expect(projected.markdown).not.toContain("![](images/a.png)");
    expect(projected.markdown).not.toContain("![](images/b.png)");
    expect(projected.markdown).not.toContain("Figure 1. Exact formal caption.");
    expect(projected.markdown).not.toMatch(/^A\s*$/m);
    expect(projected.markdown).toContain("Body remains.");
    expect(projected.markdown).toContain("<!-- p2md:slot id=\"slot_000000000000000000000001\"");
    expect(projected.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-reader-projection-applied" }));
  });

  it("suppresses a cross-page caption only when its stored UTF-16 range is exact", () => {
    const caption = "Figure 2. Caption on the next page.";
    const markdown = `# Paper\n\n![](images/a.png)\n\nBody.\n\n${caption}\n`;
    const captionStart = markdown.indexOf(caption);
    const viewerIndex = {
      schema_version: 1,
      inputs: { article: { sha256: "article" }, mineru_result: { sha256: "mineru" } },
      markdown_images: [imageEntry(markdown, "md-img-0000", "images/a.png")]
    };
    const projected = projectMinerUReaderMarkdown({
      markdown,
      visuals: [visual({
        memberAssetPaths: ["images/a.png"],
        memberMarkdownImageIds: ["md-img-0000"],
        captionText: caption,
        captionSourceRanges: [{ start: captionStart, end: captionStart + caption.length, text: caption }]
      })],
      viewerIndex,
      articleHash: "article",
      mineruHash: "mineru"
    });

    expect(projected.markdown).not.toContain(caption);
    expect(projected.markdown).toContain("Body.");
  });

  it("returns the source bytes unchanged when the viewer hash binding is stale", () => {
    const markdown = "# Paper\n\n![](images/a.png)\n";
    const projected = projectMinerUReaderMarkdown({
      markdown,
      visuals: [visual({ memberAssetPaths: ["images/a.png"], memberMarkdownImageIds: ["md-img-0000"] })],
      viewerIndex: {
        schema_version: 1,
        inputs: { article: { sha256: "stale" }, mineru_result: { sha256: "mineru" } },
        markdown_images: [imageEntry(markdown, "md-img-0000", "images/a.png")]
      },
      articleHash: "article",
      mineruHash: "mineru"
    });

    expect(projected.markdown).toBe(markdown);
    expect(projected.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-reader-projection-binding-invalid" }));
  });
});
