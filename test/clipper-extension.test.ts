import { describe, expect, it } from "vitest";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import {
  buildArticleMarkdown,
  buildClippingPackageFiles,
  collectMarkdownImages,
  isFetchableImageUrl,
  localizeMarkdownImages,
  readResponseBytesWithinLimit,
  safeArchiveName,
  type LocalizedImage
} from "../packages/clipper-core/src/index";
import type { ExtractedPaperPage } from "../apps/clipper-extension/src/messages";
import { mergeSeparatedFigureCaptions } from "../apps/clipper-extension/src/paper-dom-normalization";
import { adaptClippingMarkdown } from "../src/model/clipping-markdown";

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

  it("joins a Nature-style title and separately stored figure description before extraction", async () => {
    const fullCaption = "a, Schematic overview of DeepMet. RT, retention time. b, UMAP visualization of the chemical space occupied by known metabolites and generated molecules. c, Receiver operating characteristic curve. d, Proportion of enzymatic biotransformations recapitulated by DeepMet.";
    const html = `<!doctype html><html lang="en"><head><title>DeepMet paper</title></head><body>
      <article id="paper"><h1>DeepMet paper</h1><p>${"Evidence sentence. ".repeat(40)}</p>
      <div class="c-article-section__figure" data-container-section="figure" id="figure-1">
        <figure>
          <figcaption><b class="c-article-section__figure-caption">Fig. 1: Learning the language of metabolism.</b></figcaption>
          <div class="c-article-section__figure-content">
            <img aria-describedby="figure-1-desc" src="/media/figure-1.png" alt="Fig. 1: Learning the language of metabolism.">
            <div class="c-article-section__figure-description" data-test="bottom-caption" id="figure-1-desc"><p>${fullCaption}</p></div>
          </div>
          <a href="/figures/1">Full size image</a>
        </figure>
      </div>
      <h2>Methods</h2><p>${"Method sentence. ".repeat(40)}</p></article></body></html>`;
    const { document } = parseHTML(html);
    mergeSeparatedFigureCaptions(document);
    const normalizedHtml = document.toString();
    const result = await Defuddle(normalizedHtml, page.sourceUrl, {
      markdown: true,
      useAsync: false,
      contentSelector: "#paper"
    });

    expect(result.content).toContain("Fig. 1: Learning the language of metabolism.");
    expect(result.content).toContain(fullCaption);
    expect(result.content.match(/Schematic overview of DeepMet/g)).toHaveLength(1);
    const occurrences = collectMarkdownImages(result.content, page.sourceUrl);
    const localized = new Map<string, LocalizedImage>([[occurrences[0].absoluteUrl!, {
      url: occurrences[0].absoluteUrl!,
      path: "images/figure-0001.png",
      mime: "image/png",
      bytes: new Uint8Array([1])
    }]]);
    const readerProjection = adaptClippingMarkdown(localizeMarkdownImages(result.content, occurrences, localized));
    expect(readerProjection.visuals[0]?.captionText).toContain(fullCaption);
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

  it("builds the same deterministic clipping files for browser and service adapters", async () => {
    const localized = new Map<string, LocalizedImage>([["https://example.org/media/figure.png", {
      url: "https://example.org/media/figure.png",
      path: "images/figure-0001.png",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    }]]);
    const clipping = await buildClippingPackageFiles({
      page: { ...page, markdown: "## Results\n\n" + "Evidence. ".repeat(30) + "\n\n![Figure 1](/media/figure.png)" },
      localizedImages: localized,
      createdAt: "2026-08-27T00:00:00.000Z",
      extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false }
    });

    expect([...clipping.files.keys()]).toEqual(["article.md", "_clipping/manifest.json", "images/figure-0001.png"]);
    expect(clipping.article).toContain("![Figure 1](images/figure-0001.png)");
    expect(clipping.manifest).toMatchObject({
      schema_version: "paper2md-web-clipping-v1",
      processing: { remote: false, ai: false },
      omitted_image_count: 0,
      images: [expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]
    });
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
