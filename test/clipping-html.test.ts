import { DOMParser } from "linkedom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { convertClippingHtmlToMarkdown } from "../src/model/clipping-html";
import { PACKAGE_LIMITS, PackageLimitError } from "../src/model/package-limits";
import { PackageLoader } from "../src/model/package-loader";
import { detectPackageSource, PackageSourceNotFoundError } from "../src/model/package-source";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

describe("saved Web Clipper HTML import", () => {
  beforeAll(() => vi.stubGlobal("DOMParser", DOMParser));
  afterAll(() => vi.unstubAllGlobals());

  it("converts article structure and local figures into a display-only Markdown projection", () => {
    const source = `<!doctype html><html><head><title>Paper title</title></head><body>
      <nav>Navigation must not be imported</nav>
      <article><h1>Paper title</h1><p>Body with <strong>evidence</strong>.</p>
      <figure><img src="paper_files/figure%201.png" alt="Panel overview"><figcaption>Measured response across groups.</figcaption></figure>
      <table><tr><th>Group</th><th>Value</th></tr><tr><td>A</td><td>4</td></tr></table></article>
      <script>window.evil = true</script></body></html>`;
    const result = convertClippingHtmlToMarkdown(source, {
      sourcePath: "saved.html",
      availableImagePaths: new Set(["paper_files/figure 1.png"])
    });

    expect(result.markdown).toContain("# Paper title");
    expect(result.markdown).toContain("Body with **evidence**.");
    expect(result.markdown).toContain("![Panel overview](paper_files/figure 1.png)");
    expect(result.markdown).toContain("Measured response across groups.");
    expect(result.markdown).toContain("| Group | Value |");
    expect(result.markdown).not.toContain("Navigation must not be imported");
    expect(result.markdown).not.toContain("window.evil");
    expect(result.localImagePaths).toEqual(["paper_files/figure 1.png"]);
    expect(source).toContain("<script>");
  });

  it("omits remote, traversal, active and unavailable resources", () => {
    const result = convertClippingHtmlToMarkdown(`
      <article><p><a href="javascript:alert(1)">unsafe link</a></p>
      <img src="https://tracker.example/pixel.png" alt="remote">
      <img src="../../outside.png" alt="outside">
      <img src="images/missing.png" alt="missing">
      <iframe src="https://example.com"></iframe></article>`, {
      sourcePath: "clips/paper.html",
      availableImagePaths: new Set()
    });

    expect(result.markdown).toContain("unsafe link");
    expect(result.markdown).toContain("remote");
    expect(result.markdown).not.toContain("javascript:");
    expect(result.markdown).not.toContain("https://tracker.example");
    expect(result.markdown).not.toContain("outside.png");
    expect(result.markdown).not.toContain("missing.png");
    expect(result.blockedImageSources).toEqual(expect.arrayContaining([
      "https://tracker.example/pixel.png",
      "../../outside.png",
      "images/missing.png"
    ]));
  });

  it("loads one saved HTML document with local assets without modifying the source", async () => {
    const source = "<html><head><title>Study</title></head><body><article><p>Introduction.</p><figure><img src='images/plot.png'><figcaption>Response by group.</figcaption></figure><p>Conclusion.</p></article></body></html>";
    const fileSystem = new MemoryReaderFileSystem({
      "study.html": source,
      "images/plot.png": new Uint8Array([1, 2, 3, 4])
    });
    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.sourceFormat).toBe("html");
    expect(loaded.state).toBe("markdown");
    expect(loaded.articleText).toContain("# Study");
    expect(loaded.articleText).toContain("p2md:slot");
    expect(loaded.assets).toEqual([expect.objectContaining({
      path: "images/plot.png",
      display_label: "Fig. 1",
      captionText: "Response by group.",
      exists: true
    })]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "html-display-conversion" }));
    expect(await fileSystem.readText("study.html")).toBe(source);
  });

  it("keeps readable text while omitting unavailable images", async () => {
    const loaded = await new PackageLoader(new MemoryReaderFileSystem({
      "study.htm": "<article><h1>Study</h1><p>Body remains readable.</p><img src='https://example.com/track.png'><img src='images/missing.png'></article>"
    })).loadDetected();

    expect(loaded.sourceFormat).toBe("html");
    expect(loaded.articleText).toContain("Body remains readable.");
    expect(loaded.articleText).not.toContain("https://example.com");
    expect(loaded.articleText).not.toContain("images/missing.png");
    expect(loaded.assets).toEqual([]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "html-resource-omitted" }));
  });

  it("fails closed when a folder contains multiple HTML documents", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "a.html": "<article>A</article>",
      "b.html": "<article>B</article>"
    });
    await expect(detectPackageSource(fileSystem)).rejects.toBeInstanceOf(PackageSourceNotFoundError);
  });

  it("bounds image expansion before filesystem lookups", () => {
    const images = Array.from(
      { length: PACKAGE_LIMITS.assetCount + 1 },
      (_, index) => `<img src="images/${index}.png">`
    ).join("");
    expect(() => convertClippingHtmlToMarkdown(`<article>${images}</article>`, {
      sourcePath: "study.html"
    })).toThrow(PackageLimitError);
  });

  it("bounds table normalization before padding wide rows", () => {
    const cells = Array.from({ length: 129 }, (_, index) => `<td>${index}</td>`).join("");
    expect(() => convertClippingHtmlToMarkdown(`<article><table><tr>${cells}</tr></table></article>`, {
      sourcePath: "study.html"
    })).toThrow(PackageLimitError);
  });
});
