import { describe, expect, it } from "vitest";
import { PackageLoader } from "../src/model/package-loader";
import { HASHES, makeArticle, makeContract } from "./reader-fixture";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("PackageLoader host abstraction", () => {
  it("loads a valid package through a host-neutral file system", async () => {
    const article = makeArticle();
    const image = new Uint8Array([137, 80, 78, 71]);
    const contract = makeContract();
    contract.article.sha256 = await sha256(article);
    contract.assets[0].sha256 = await sha256(image);
    contract.assets[0].size_bytes = image.byteLength;

    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "_paper2md/reader.json": JSON.stringify(contract),
      "images/figure-0001.png": image
    });
    const loaded = await new PackageLoader(fileSystem).load();

    expect(loaded.state).toBe("valid");
    expect(loaded.assets).toEqual([expect.objectContaining({ exists: true, integrityMatches: true })]);
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ code: "manifest-missing", level: "warning" })]);
  });

  it("uses a filename-only image list when reader.json is absent", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# Local fallback",
      "images/figure-0002.png": new Uint8Array([1, 2, 3]),
      "images/readme.txt": "ignored"
    });
    const loaded = await new PackageLoader(fileSystem).load();

    expect(loaded.state).toBe("reader-missing");
    expect(loaded.assets.map((asset) => asset.path)).toEqual(["images/figure-0002.png"]);
  });

  it("rejects traversal before reading from the selected package", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "article.md": "# Safe" });
    await expect(new PackageLoader(fileSystem).load("../article.md")).rejects.toThrow("Unsafe article path");
  });

  it("keeps unsupported versions in safe fallback mode", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# Future",
      "_paper2md/reader.json": JSON.stringify({ contract_version: "paper2md-reader-v9.0", source_sha256: HASHES.source })
    });
    const loaded = await new PackageLoader(fileSystem).load();
    expect(loaded.state).toBe("unsupported-version");
    expect(loaded.contract).toBeUndefined();
  });

  it("recognizes the normalized article.md plus mineru-result.json package before Markdown fallback", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# MinerU paper\n\nBody text.\n\n![](images/figure.png)\n",
      "mineru-result.json": JSON.stringify([{
        type: "image",
        page_idx: 2,
        img_path: "images/figure.png",
        image_caption: ["Figure 1. Structured output"]
      }]),
      "images/figure.png": new Uint8Array([137, 80, 78, 71])
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.state).toBe("mineru");
    expect(loaded.sourceFormat).toBe("mineru");
    expect(loaded.contractPath).toBe("fixture/mineru-result.json");
    expect(loaded.assets).toEqual([
      expect.objectContaining({ path: "images/figure.png", pageIndex: 2, display_label: "Figure 1" })
    ]);
  });

  it("replaces high-confidence MinerU fragments with one hash-bound PDF crop", async () => {
    const article = "# MinerU paper\n\n![](images/a.png)\n\n![](images/b.png)\n";
    const mineru = JSON.stringify([
      { type: "image", page_idx: 2, bbox: [60, 300, 490, 700], img_path: "images/a.png", image_caption: ["A"] },
      { type: "image", page_idx: 2, bbox: [510, 300, 940, 700], img_path: "images/b.png", image_caption: ["Figure 1. Complete caption"] }
    ]);
    const articleHash = await sha256(article);
    const mineruHash = await sha256(mineru);
    const inputs = {
      article: { path: "article.md", sha256: articleHash },
      mineru_result: { path: "mineru-result.json", sha256: mineruHash }
    };
    const imageRange = (id: string, path: string) => {
      const token = `![](${path})`;
      const start = article.indexOf(token);
      return { id, asset_path: path, char_start: start, char_end: start + token.length };
    };
    const viewerIndex = {
      schema_version: 1,
      inputs,
      markdown_images: [imageRange("md-img-a", "images/a.png"), imageRange("md-img-b", "images/b.png")],
      pages: [{
        page_idx: 2,
        blocks: [
          { id: "p0002-s000000", source_index: 0, page_order: 0, role: "visual", source_type: "image", bbox_norm: [60, 300, 490, 700], asset_path: "images/a.png", markdown_image_ids: ["md-img-a"], caption: { items: [{ text: "A", kind: "panel-label" }] } },
          { id: "p0002-s000001", source_index: 1, page_order: 1, role: "visual", source_type: "image", bbox_norm: [510, 300, 940, 700], asset_path: "images/b.png", markdown_image_ids: ["md-img-b"], caption: { items: [{ text: "Figure 1. Complete caption", kind: "formal-caption" }] } }
        ]
      }]
    };
    const visualRepair = {
      schema_version: 1,
      algorithm_version: "visual-repair-v1.6",
      inputs,
      groups: [{
        id: "vr-p0002-g0000",
        page_idx: 2,
        member_block_ids: ["p0002-s000000", "p0002-s000001"],
        member_asset_paths: ["images/a.png", "images/b.png"],
        member_markdown_image_ids: ["md-img-a", "md-img-b"],
        decision: "auto",
        confidence: 0.99,
        replacement: { mode: "pdf_crop", bbox_norm: [60, 300, 940, 700], padding_norm: 6 }
      }]
    };
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "mineru-result.json": mineru,
      "images/a.png": new Uint8Array([1]),
      "images/b.png": new Uint8Array([2]),
      "_extraction/source.pdf": new Uint8Array([37, 80, 68, 70, 45]),
      "_extraction/viewer-index.json": JSON.stringify(viewerIndex),
      "_extraction/visual-repair.json": JSON.stringify(visualRepair)
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.assets).toHaveLength(1);
    expect(loaded.assets[0]).toEqual(expect.objectContaining({
      id: "vr-p0002-g0000",
      display_label: "Figure 1",
      memberAssetPaths: ["images/a.png", "images/b.png"],
      display: expect.objectContaining({ mode: "pdf-crop", pdfPath: "_extraction/source.pdf" })
    }));
    expect(loaded.sourcePdf).toEqual({ path: "_extraction/source.pdf" });
    expect(loaded.pdfLayout?.blocks).toHaveLength(2);
    expect(loaded.pdfLayout?.blocks.every((block) => block.visualId === "vr-p0002-g0000")).toBe(true);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-visual-repair-applied" }));
  });

  it("still validates a folded member asset that is not referenced by the PDF layout", async () => {
    const article = "# MinerU paper\n\n![](images/a.png)\n\n![](images/b.png)\n";
    const mineru = JSON.stringify([
      { type: "image", page_idx: 2, bbox: [60, 300, 490, 700], img_path: "images/a.png" },
      { type: "table", page_idx: 2, bbox: [510, 300, 940, 700], img_path: "images/b.png" }
    ]);
    const articleHash = await sha256(article);
    const mineruHash = await sha256(mineru);
    const inputs = {
      article: { path: "article.md", sha256: articleHash },
      mineru_result: { path: "mineru-result.json", sha256: mineruHash }
    };
    const imageRange = (id: string, path: string) => {
      const token = `![](${path})`;
      const start = article.indexOf(token);
      return { id, asset_path: path, char_start: start, char_end: start + token.length };
    };
    const viewerIndex = {
      schema_version: 1,
      inputs,
      markdown_images: [imageRange("md-img-a", "images/a.png"), imageRange("md-img-b", "images/b.png")],
      pages: [{
        page_idx: 2,
        blocks: [
          { id: "p0002-s000000", source_index: 0, page_order: 0, role: "visual", source_type: "image", bbox_norm: [60, 300, 490, 700], asset_path: "images/a.png", markdown_image_ids: ["md-img-a"], caption: { items: [] } },
          { id: "p0002-s000001", source_index: 1, page_order: 1, role: "table", source_type: "table", bbox_norm: [510, 300, 940, 700], asset_path: "images/b.png", markdown_image_ids: ["md-img-b"], caption: { items: [] } }
        ]
      }]
    };
    const visualRepair = {
      schema_version: 1,
      inputs,
      groups: [{
        id: "vr-p0002-g0000",
        page_idx: 2,
        member_block_ids: ["p0002-s000000", "p0002-s000001"],
        member_asset_paths: ["images/a.png", "images/b.png"],
        member_markdown_image_ids: ["md-img-a", "md-img-b"],
        decision: "auto",
        confidence: 0.99,
        replacement: { mode: "pdf_crop", bbox_norm: [60, 300, 940, 700], padding_norm: 6 }
      }]
    };
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "mineru-result.json": mineru,
      "images/a.png": new Uint8Array([1]),
      "_extraction/source.pdf": new Uint8Array([37, 80, 68, 70, 45]),
      "_extraction/viewer-index.json": JSON.stringify(viewerIndex),
      "_extraction/visual-repair.json": JSON.stringify(visualRepair)
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.assets).toHaveLength(1);
    expect(loaded.assets[0].memberAssetPaths).toEqual(["images/a.png", "images/b.png"]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      code: "mineru-asset-missing",
      message: "MinerU 资源不存在：images/b.png"
    }));
  });

  it("fails closed when a MinerU visual repair contract hash is stale", async () => {
    const article = "# MinerU paper\n\n![](images/a.png)\n";
    const mineru = JSON.stringify([{ type: "image", page_idx: 0, bbox: [0, 0, 500, 500], img_path: "images/a.png" }]);
    const staleInputs = {
      article: { path: "article.md", sha256: "0".repeat(64) },
      mineru_result: { path: "mineru-result.json", sha256: "0".repeat(64) }
    };
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "mineru-result.json": mineru,
      "images/a.png": new Uint8Array([1]),
      "_extraction/source.pdf": new Uint8Array([37, 80, 68, 70, 45]),
      "_extraction/viewer-index.json": JSON.stringify({ schema_version: 1, inputs: staleInputs, pages: [] }),
      "_extraction/visual-repair.json": JSON.stringify({ schema_version: 1, inputs: staleInputs, groups: [] })
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.assets).toHaveLength(1);
    expect(loaded.assets[0].display).toBeUndefined();
    expect(loaded.pdfLayout).toBeUndefined();
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-visual-repair-binding-invalid" }));
  });

  it("projects a unique next-page formal caption from the original MinerU payload without editing article.md", async () => {
    const placeholder = "Fig. 2 | See next page for caption";
    const caption = "Fig. 2. Caption begins on the next PDF page.";
    const article = `# MinerU paper\n\n![](images/a.png)\n\n${placeholder}\np\nq\n![](images/b.png)\n\n${caption}\n\nBody remains.\n`;
    const mineruPayload = [
      { type: "image", page_idx: 0, bbox: [50, 200, 450, 700], img_path: "images/a.png" },
      { type: "image", page_idx: 0, bbox: [460, 200, 950, 700], img_path: "images/b.png" },
      { type: "text", page_idx: 1, bbox: [50, 40, 950, 180], text: caption }
    ];
    const mineru = JSON.stringify(mineruPayload);
    const articleHash = await sha256(article);
    const mineruHash = await sha256(mineru);
    const inputs = {
      article: { path: "article.md", sha256: articleHash },
      mineru_result: { path: "mineru-result.json", sha256: mineruHash }
    };
    const imageRange = (id: string, path: string) => {
      const token = `![](${path})`;
      const start = article.indexOf(token);
      return { id, asset_path: path, char_start: start, char_end: start + token.length };
    };
    const viewerIndex = {
      schema_version: 1,
      inputs,
      markdown_images: [imageRange("md-img-0000", "images/a.png"), imageRange("md-img-0001", "images/b.png")],
      pages: [
        {
          page_idx: 0,
          blocks: [
            { id: "p0000-s000000", source_index: 0, page_order: 0, role: "visual", bbox_norm: [50, 200, 450, 700], asset_path: "images/a.png", markdown_image_ids: ["md-img-0000"], caption: { items: [] } },
            {
              id: "p0000-s000001", source_index: 1, page_order: 1, role: "visual", bbox_norm: [460, 200, 950, 700], asset_path: "images/b.png", markdown_image_ids: ["md-img-0001"],
              caption: {
                items: [
                  { kind: "next-page-placeholder", text: placeholder },
                  { kind: "panel-label", text: "p" },
                  { kind: "panel-label", text: "q" }
                ],
                next_page_marker: true,
                next_page_figure_keys: ["figure:2"]
              }
            }
          ]
        },
        {
          page_idx: 1,
          blocks: [{
            id: "p0001-s000002",
            source_index: 2,
            page_order: 0,
            role: "text",
            bbox_norm: [50, 40, 950, 180],
            text: {
              leading_formal_figure_caption_key: "figure:2",
              formal_figure_caption_keys: ["figure:2"],
              ends_with_terminal_punctuation: true
            },
            caption: { items: [] }
          }]
        }
      ]
    };
    const visualRepair = {
      schema_version: 1,
      inputs,
      caption_links: [],
      groups: [{
        id: "vr-p0000-g0000",
        page_idx: 0,
        member_block_ids: ["p0000-s000000", "p0000-s000001"],
        member_asset_paths: ["images/a.png", "images/b.png"],
        member_markdown_image_ids: ["md-img-0000", "md-img-0001"],
        decision: "auto",
        confidence: 0.99,
        replacement: { mode: "pdf_crop", bbox_norm: [50, 200, 950, 700], padding_norm: 6 }
      }]
    };
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "mineru-result.json": mineru,
      "images/a.png": new Uint8Array([1]),
      "images/b.png": new Uint8Array([2]),
      "_extraction/source.pdf": new Uint8Array([37, 80, 68, 70, 45]),
      "_extraction/viewer-index.json": JSON.stringify(viewerIndex),
      "_extraction/visual-repair.json": JSON.stringify(visualRepair)
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(article).toContain(caption);
    expect(article).toContain(placeholder);
    expect(loaded.articleText).not.toContain(caption);
    expect(loaded.articleText).not.toContain(placeholder);
    expect(loaded.articleText).not.toContain("![](images/a.png)");
    expect(loaded.articleText).toContain("Body remains.");
    expect(loaded.assets).toEqual([expect.objectContaining({
      display_label: "Fig. 2",
      captionText: caption,
      captionPageIndex: 1,
      captionStatus: "complete"
    })]);
  });
});
