import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublishedPackageCatalog } from "../apps/processing-service/src/published-package-catalog";

const catalog = new PublishedPackageCatalog(
  resolve("test", "processing-catalog"),
  "http://127.0.0.1:4174/"
);

describe("published package catalog", () => {
  it("discovers only complete manifest-verified packages after a service restart", async () => {
    await expect(catalog.list(undefined, 25)).resolves.toEqual({
      packages: [
        expect.objectContaining({
          package_id: "pkg-clipping",
          label: "Catalog fixture",
          kind: "clipping",
          integrity: "hash-bound",
          file_count: 5,
          reader_url: "http://127.0.0.1:4174/reader/pkg-clipping"
        }),
        expect.objectContaining({
          package_id: "pkg-mineru",
          label: "MinerU fixture",
          kind: "mineru",
          integrity: "hash-bound",
          file_count: 7
        })
      ],
      next_cursor: null
    });
    await expect(catalog.descriptor("pkg-invalid")).rejects.toThrow("does not match");
    await expect(catalog.list(undefined, 1)).resolves.toMatchObject({
      packages: [{ package_id: "pkg-clipping" }],
      next_cursor: "pkg-clipping"
    });
    await expect(catalog.list("pkg-clipping", 1)).resolves.toMatchObject({
      packages: [{ package_id: "pkg-mineru" }],
      next_cursor: null
    });
  });

  it("returns the validated manifest without accepting arbitrary paths", async () => {
    await expect(catalog.readManifest("pkg-clipping")).resolves.toMatchObject({
      package_id: "pkg-clipping",
      kind: "clipping",
      integrity: "hash-bound",
      manifest_path: "_clipping/manifest.json",
      manifest: { schema_version: "paper2md-web-clipping-v1" },
      validation: { status: "passed" }
    });
    await expect(catalog.packageFilePath("pkg-clipping", "../outside.txt")).rejects.toThrow("Unsafe");
  });

  it("reads bounded Markdown sections using stable heading IDs", async () => {
    const overview = await catalog.readArticleSection({ package_id: "pkg-clipping", max_lines: 8 });
    expect(overview).toMatchObject({
      package_id: "pkg-clipping",
      start_line: 1,
      end_line: 8,
      truncated: true,
      headings: [
        expect.objectContaining({ heading_id: "heading-0001", label: "Catalog fixture", level: 1 }),
        expect.objectContaining({ heading_id: "heading-0002", label: "Results", level: 2 }),
        expect.objectContaining({ heading_id: "heading-0003", label: "Discussion", level: 2 })
      ]
    });

    const results = await catalog.readArticleSection({ package_id: "pkg-clipping", heading_id: "heading-0002" });
    expect(results.content).toContain("bounded section reader");
    expect(results.content).not.toContain("next section");
    expect(results).toMatchObject({ heading_id: "heading-0002", truncated: false });
  });

  it("lists deterministic figure metadata without returning asset bytes", async () => {
    await expect(catalog.listFigures("pkg-clipping")).resolves.toEqual({
      package_id: "pkg-clipping",
      count: 1,
      truncated: false,
      figures: [expect.objectContaining({
        path: "images/figure-0001.png",
        label: "Fig. 1",
        caption_text: "Figure 1. Verified catalog fixture."
      })]
    });
    await expect(catalog.listFigures("pkg-mineru")).resolves.toEqual({
      package_id: "pkg-mineru",
      count: 1,
      truncated: false,
      figures: [expect.objectContaining({
        figure_id: "asset-figure",
        path: "images/figure-2.png",
        label: "Figure 2",
        page_index: 2,
        placement_block_id: "slot-figure",
        caption_block_id: "blk-caption"
      })]
    });
  });
});
