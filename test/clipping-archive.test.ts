import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CLIPPING_ARCHIVE_COMPRESSED_BYTES,
  assertClippingArchiveByteLength,
  clippingArchiveRootLabel,
  extractClippingArchiveBytes
} from "../src/model/clipping-archive";
import { BrowserDirectoryReaderFileSystem } from "../src/filesystem/browser-directory-reader-file-system";
import { PackageLoader } from "../src/model/package-loader";

describe("Paper2MD web clipping archives", () => {
  it("opens a bounded immutable article and local image package", async () => {
    const source = "# Paper\n\n![Figure 1](images/figure-0001.png)\n\nFigure 1. Local caption.\n";
    const archive = zipSync({
      "article.md": strToU8(source),
      "images/figure-0001.png": new Uint8Array([1, 2, 3]),
      "_clipping/manifest.json": strToU8("{}\n")
    });
    const files = extractClippingArchiveBytes(archive);
    const loaded = await new PackageLoader(BrowserDirectoryReaderFileSystem.fromFileMap("Paper", files)).loadDetected();

    expect(loaded.state).toBe("markdown");
    expect(loaded.sourceFormat).toBe("paper2md");
    expect(loaded.assets).toEqual([expect.objectContaining({
      path: "images/figure-0001.png",
      captionText: "Figure 1. Local caption.",
      exists: true
    })]);
    expect(await files.get("article.md")?.text()).toBe(source);
  });

  it("rejects traversal and missing article entries", () => {
    const traversal = zipSync({ "../article.md": strToU8("# unsafe") });
    expect(() => extractClippingArchiveBytes(traversal)).toThrow(/Unsafe clipping archive path/);
    const noArticle = zipSync({ "note.md": strToU8("# Not the package article") });
    expect(() => extractClippingArchiveBytes(noArticle)).toThrow(/does not contain article\.md/);
  });

  it("ignores directory records and rejects an oversized file before reading its bytes", () => {
    const archive = zipSync({
      "images/": new Uint8Array(),
      "article.md": strToU8("# Paper\n")
    });
    expect(extractClippingArchiveBytes(archive).has("article.md")).toBe(true);
    expect(() => assertClippingArchiveByteLength(CLIPPING_ARCHIVE_COMPRESSED_BYTES + 1))
      .toThrow(/safe limit/);
  });

  it("derives a readable package label", () => {
    expect(clippingArchiveRootLabel("My paper.paper2md.zip")).toBe("My paper");
  });
});
