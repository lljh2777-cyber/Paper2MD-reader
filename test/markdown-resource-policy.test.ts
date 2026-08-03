import { describe, expect, it } from "vitest";
import { PACKAGE_LIMITS, PackageLimitError } from "../src/model/package-limits";
import {
  assertMarkdownResourcesSafe,
  inspectMarkdownResources,
  safeLocalResourcePath,
  UnsafeMarkdownResourceError
} from "../src/render/markdown-resource-policy";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

describe("Markdown resource policy", () => {
  it("allows ordinary external links without treating them as resources", () => {
    expect(inspectMarkdownResources("[paper](https://example.com/paper)")).toEqual({
      localPaths: [], blockedUrls: [], resourceCount: 0
    });
  });

  it.each([
    "![remote](https://tracker.example/pixel.png)",
    "![remote][pixel]\n\n[pixel]: //tracker.example/pixel.png",
    '<img src="http://tracker.example/pixel.png">',
    '<img src="https&#x3a;//tracker.example/pixel.png">',
    '<img alt=">" src="https://tracker.example/pixel.png">',
    "![encoded](https%3A%2F%2Ftracker.example%2Fpixel.png)",
    "![[https://tracker.example/pixel.png]]"
  ])("blocks a remote rendered resource before rendering: %s", async (markdown) => {
    await expect(assertMarkdownResourcesSafe(markdown, new MemoryReaderFileSystem({})))
      .rejects.toBeInstanceOf(UnsafeMarkdownResourceError);
  });

  it("rejects traversal, malformed encoding, and missing package resources", async () => {
    expect(safeLocalResourcePath("../secret.png")).toBeUndefined();
    expect(safeLocalResourcePath("images/%zz.png")).toBeUndefined();
    await expect(assertMarkdownResourcesSafe("![missing](images/missing.png)", new MemoryReaderFileSystem({})))
      .rejects.toBeInstanceOf(UnsafeMarkdownResourceError);
  });

  it("accepts a bounded package-local image", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "images/figure.png": new Uint8Array([1, 2, 3]) });
    await expect(assertMarkdownResourcesSafe("![local](images/figure.png)", fileSystem)).resolves.toBeUndefined();
  });

  it("rejects a local resource whose reported size exceeds the image limit", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "images/figure.png": new Uint8Array([1]) });
    fileSystem.fileInfo = async () => ({ size: PACKAGE_LIMITS.assetBytes + 1 });
    await expect(assertMarkdownResourcesSafe("![large](images/figure.png)", fileSystem))
      .rejects.toBeInstanceOf(PackageLimitError);
  });

  it("counts repeated rendered resources instead of only unique paths", async () => {
    const markdown = Array.from(
      { length: PACKAGE_LIMITS.renderedResourceCount + 1 },
      () => "![same](images/figure.png)"
    ).join("\n");
    const fileSystem = new MemoryReaderFileSystem({ "images/figure.png": new Uint8Array([1]) });

    await expect(assertMarkdownResourcesSafe(markdown, fileSystem)).rejects.toBeInstanceOf(PackageLimitError);
  });
});
