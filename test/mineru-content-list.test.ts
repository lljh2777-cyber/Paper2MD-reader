import { describe, expect, it } from "vitest";
import { injectMinerUVisualAnchors, parseMinerUContentList } from "../src/model/mineru-content-list";
import { PackageLoader } from "../src/model/package-loader";
import { detectPackageSource, PackageSourceNotFoundError } from "../src/model/package-source";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

const markdown = `# MinerU paper

Body before the first figure.

![](images/figure-a.jpg)

Fig. 1. A structured result from MinerU.

![](images/table-a.jpg)

Table 1 Results by group.
`;

const contentList = [
  {
    type: "text",
    text: "MinerU paper",
    text_level: 1,
    bbox: [70, 80, 930, 130],
    page_idx: 0
  },
  {
    type: "image",
    img_path: "images/figure-a.jpg",
    image_caption: ["Fig. 1. A structured result from MinerU."],
    image_footnote: [],
    bbox: [100, 200, 900, 620],
    page_idx: 1
  },
  {
    type: "table",
    img_path: "images/table-a.jpg",
    table_caption: ["Table 1 Results by group."],
    table_footnote: [],
    table_body: "<table></table>",
    bbox: [120, 180, 880, 700],
    page_idx: 2
  }
];

describe("MinerU result package adapter", () => {
  it("detects and loads a stable content_list package with linked visuals", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "paper.md": markdown,
      "paper_content_list.json": JSON.stringify(contentList),
      "images/figure-a.jpg": new Uint8Array([1, 2, 3]),
      "images/table-a.jpg": new Uint8Array([4, 5, 6])
    });

    expect(await detectPackageSource(fileSystem)).toEqual({
      format: "mineru",
      articlePath: "paper.md",
      contentListPath: "paper_content_list.json"
    });
    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.state).toBe("mineru");
    expect(loaded.sourceFormat).toBe("mineru");
    expect(loaded.contractVersion).toBe("mineru-content-list-v1");
    expect(loaded.articleText).toContain("<!-- p2md:slot");
    expect(loaded.assets).toEqual([
      expect.objectContaining({
        kind: "figure",
        path: "images/figure-a.jpg",
        display_label: "Fig. 1",
        captionText: "Fig. 1. A structured result from MinerU.",
        pageIndex: 1,
        sourceBBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.42 },
        exists: true
      }),
      expect.objectContaining({
        kind: "table",
        path: "images/table-a.jpg",
        display_label: "Table 1",
        pageIndex: 2,
        exists: true
      })
    ]);
    expect(loaded.assets.every((asset) => Boolean(asset.placement_block_id))).toBe(true);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-structured-source", level: "info" }));
  });

  it("detects the real MinerU full.md plus UUID content-list naming convention", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "full.md": markdown,
      "b252db0a-e453-4514-83de-226ea2fb9b02_content_list.json": JSON.stringify(contentList),
      "b252db0a-e453-4514-83de-226ea2fb9b02_origin.pdf": new Uint8Array([1]),
      "images/figure-a.jpg": new Uint8Array([2]),
      "images/table-a.jpg": new Uint8Array([3])
    });

    expect(await detectPackageSource(fileSystem)).toEqual({
      format: "mineru",
      articlePath: "full.md",
      contentListPath: "b252db0a-e453-4514-83de-226ea2fb9b02_content_list.json"
    });
    expect((await new PackageLoader(fileSystem).load("full.md")).state).toBe("mineru");
  });

  it("keeps multiple MinerU caption lines separated", () => {
    const parsed = parseMinerUContentList([{
      type: "image",
      img_path: "images/figure-a.jpg",
      image_caption: ["Figure 1. Main caption", "(A) Panel description"],
      page_idx: 0
    }]);
    expect(parsed.visuals[0].captionText).toBe("Figure 1. Main caption\n(A) Panel description");
  });

  it("combines MinerU caption and footnote lines", () => {
    const parsed = parseMinerUContentList([{
      type: "image",
      img_path: "images/figure-a.jpg",
      image_caption: ["Figure 1. Main caption", "(A) First panel"],
      image_footnote: ["(B) Second panel"],
      page_idx: 0
    }]);
    expect(parsed.visuals[0].captionText).toBe("Figure 1. Main caption\n(A) First panel\n(B) Second panel");
  });

  it("uses the complete Markdown caption when content-list is incomplete or empty", () => {
    const parsed = parseMinerUContentList([{
      type: "image",
      img_path: "images/figure-a.jpg",
      image_caption: ["Figure 1. Main caption"],
      page_idx: 0
    }, {
      type: "image",
      img_path: "images/figure-b.jpg",
      image_caption: [],
      page_idx: 1
    }]);
    const source = `![](images/figure-a.jpg)\nFigure 1. Main caption  \n(A) First panel  \n(B) Second panel.\n\n![](images/figure-b.jpg)\n\nBody between image and caption.\n\n## Section\n\nFigure 2. Displaced but complete caption.`;
    injectMinerUVisualAnchors(source, parsed.visuals);
    expect(parsed.visuals[0].captionText).toBe("Figure 1. Main caption\n(A) First panel\n(B) Second panel.");
    expect(parsed.visuals[1].captionText).toBe("Figure 2. Displaced but complete caption.");
    expect(parsed.visuals[1].label).toBe("Figure 2");
  });

  it("uses the same structured adapter when Obsidian opens the MinerU Markdown directly", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "paper.md": markdown,
      "paper_content_list.json": JSON.stringify(contentList),
      "images/figure-a.jpg": new Uint8Array([1]),
      "images/table-a.jpg": new Uint8Array([2])
    });
    const loaded = await new PackageLoader(fileSystem).load("paper.md");
    expect(loaded.state).toBe("mineru");
    expect(loaded.assets).toHaveLength(2);
  });

  it("accepts current content_list_v2 visual fields while marking the format as provisional", () => {
    const parsed = parseMinerUContentList([[{
      type: "image",
      content: {
        image_path: "images/v2.png",
        image_caption: [{ type: "text", content: "Figure 2 V2 caption" }]
      },
      bbox: [100, 100, 500, 400]
    }]]);
    expect(parsed.version).toBe("v2");
    expect(parsed.visuals).toEqual([expect.objectContaining({
      path: "images/v2.png",
      captionText: "Figure 2 V2 caption",
      pageIndex: 0
    })]);
  });

  it("rejects unsafe MinerU image paths without exposing them to the filesystem", () => {
    const parsed = parseMinerUContentList([{
      type: "image",
      img_path: "../outside.jpg",
      image_caption: ["Fig. 1 unsafe"],
      page_idx: 0
    }]);
    expect(parsed.visuals).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-visual-path-invalid" }));
  });

  it("reads a single Markdown file produced by MCP without requiring Paper2MD filenames", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "mcp-result.md": "# MCP Markdown\n\nReadable text." });
    const loaded = await new PackageLoader(fileSystem).loadDetected();
    expect(loaded.sourceFormat).toBe("markdown");
    expect(loaded.state).toBe("reader-missing");
    expect(loaded.articleText).toContain("MCP Markdown");
  });

  it("keeps article.md as the backward-compatible first choice", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# Paper2MD",
      "paper.md": markdown,
      "paper_content_list.json": JSON.stringify(contentList)
    });
    expect(await detectPackageSource(fileSystem)).toEqual({ format: "paper2md", articlePath: "article.md" });
  });

  it("fails explicitly when a folder has no unambiguous readable result", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "a.md": "# A", "b.md": "# B" });
    await expect(detectPackageSource(fileSystem)).rejects.toBeInstanceOf(PackageSourceNotFoundError);
  });

  it("injects no false slot when the JSON visual is absent from Markdown", () => {
    const parsed = parseMinerUContentList(contentList);
    const result = injectMinerUVisualAnchors("# Text only", parsed.visuals);
    expect(result).toBe("# Text only");
    expect(parsed.visuals.every((visual) => visual.placementBlockId === undefined)).toBe(true);
  });
});
