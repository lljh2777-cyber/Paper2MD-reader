import { describe, expect, it } from "vitest";
import { Defuddle } from "defuddle/node";
import {
  buildArticleMarkdown,
  collectMarkdownImages,
  isFetchableImageUrl,
  localizeMarkdownImages,
  readResponseBytesWithinLimit,
  safeArchiveName,
  type LocalizedImage
} from "../apps/clipper-extension/src/clipping-package";
import type { ExtractedPaperPage } from "../apps/clipper-extension/src/messages";

const page: ExtractedPaperPage = {
  title: "A paper: multiscale maps",
  author: "A. Researcher",
  published: "2026-08-27",
  description: "A structured paper page.",
  sourceUrl: "https://example.org/articles/paper/",
  language: "en",
  wordCount: 400,
  markdown: "Body."
};

describe("Paper2MD browser clipper package projection", () => {
  it("uses Defuddle to preserve structured paper text, figures, and captions", async () => {
    const html = `<!doctype html><html lang="en"><head>
      <title>Structured paper</title><meta name="author" content="A. Researcher">
      </head><body><nav>Journal navigation</nav><article id="paper">
      <h1>Structured paper</h1><h2>Abstract</h2><p>${"Evidence sentence. ".repeat(40)}</p>
      <figure><img src="/media/figure-1.png" alt="Figure 1"><figcaption>Figure 1. Measured response across groups.</figcaption></figure>
      <h2>Methods</h2><p>${"Method sentence. ".repeat(40)}</p></article></body></html>`;
    const result = await Defuddle(html, page.sourceUrl, {
      markdown: true,
      useAsync: false,
      contentSelector: "#paper"
    });

    expect(result.title).toBe("Structured paper");
    expect(result.content).toContain("## Abstract");
    expect(result.content).toContain("figure-1.png");
    expect(result.content).toContain("Figure 1. Measured response across groups.");
    expect(result.content).not.toContain("Journal navigation");
  });

  it("localizes paper images in document order and preserves adjacent captions", () => {
    const source = [
      "Introduction.",
      "",
      "![First panel](/media/fig-a.png)",
      "",
      "Figure 4. The first caption.",
      "",
      "![Second panel](https://cdn.example.org/fig-b.jpg)",
      "",
      "Figure 2. The second caption."
    ].join("\n");
    const occurrences = collectMarkdownImages(source, page.sourceUrl);
    const localized = new Map<string, LocalizedImage>([
      [occurrences[0].absoluteUrl!, {
        url: occurrences[0].absoluteUrl!,
        path: "images/figure-0001.png",
        mime: "image/png",
        bytes: new Uint8Array([1])
      }]
    ]);
    const projected = localizeMarkdownImages(source, occurrences, localized);

    expect(occurrences.map((occurrence) => occurrence.absoluteUrl)).toEqual([
      "https://example.org/media/fig-a.png",
      "https://cdn.example.org/fig-b.jpg"
    ]);
    expect(projected).toContain("![First panel](images/figure-0001.png)\n\nFigure 4. The first caption.");
    expect(projected).toContain("[Second panel · image not included](https://cdn.example.org/fig-b.jpg)\n\nFigure 2. The second caption.");
    expect(source).toContain("![First panel](/media/fig-a.png)");
  });

  it("adds stable frontmatter without mutating extracted Markdown", () => {
    const source = "## Abstract\n\nEvidence.";
    const article = buildArticleMarkdown(page, source, "2026-08-27T00:00:00.000Z");

    expect(article).toContain('source: "https://example.org/articles/paper/"');
    expect(article).toContain("# A paper: multiscale maps");
    expect(article).toContain(source);
    expect(source).toBe("## Abstract\n\nEvidence.");
    expect(safeArchiveName(page.title)).toBe("A paper multiscale maps.paper2md.zip");
  });

  it("ignores non-network and malformed image sources", () => {
    const source = "![](data:image/png;base64,AAAA)\n\n![](javascript:alert%281%29)";
    const occurrences = collectMarkdownImages(source, page.sourceUrl);
    expect(occurrences).toHaveLength(2);
    expect(occurrences.every((occurrence) => occurrence.absoluteUrl === undefined)).toBe(true);
    expect(localizeMarkdownImages(source, occurrences, new Map())).not.toContain("![](");
  });

  it("blocks private, local, credentialed, and raw IPv6 image targets", () => {
    for (const url of [
      "http://127.0.0.1/image.png",
      "http://192.168.1.2/image.png",
      "http://service.local/image.png",
      "https://user:pass@example.org/image.png",
      "https://[::1]/image.png"
    ]) expect(isFetchableImageUrl(new URL(url))).toBe(false);
    expect(isFetchableImageUrl(new URL("https://cdn.ncbi.nlm.nih.gov/image.png"))).toBe(true);
  });

  it("stops reading an image response as soon as its byte limit is crossed", async () => {
    const accepted = await readResponseBytesWithinLimit(new Response(new Uint8Array([1, 2, 3])), 3);
    expect([...accepted]).toEqual([1, 2, 3]);
    await expect(readResponseBytesWithinLimit(new Response(new Uint8Array([1, 2, 3])), 2))
      .rejects.toThrow(/safe size limit/);
  });
});
