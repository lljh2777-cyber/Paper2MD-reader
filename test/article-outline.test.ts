import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleOutline, collectArticleOutlineEntries } from "../src/render/article-outline";

describe("article outline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("collects readable heading levels in document order and assigns stable targets", () => {
    const { document } = parseHTML(`
      <article>
        <h1>Paper title</h1>
        <h2>Introduction <em>and scope</em></h2>
        <h3 id="existing-heading">Methods</h3>
        <h4>Results</h4>
        <h5>Supplement</h5>
      </article>
    `);
    const article = document.querySelector("article") as unknown as HTMLElement;

    const entries = collectArticleOutlineEntries(article);

    expect(entries.map(({ level, label, targetId }) => ({ level, label, targetId }))).toEqual([
      { level: 1, label: "Paper title", targetId: "p2md-outline-heading-1" },
      { level: 2, label: "Introduction and scope", targetId: "p2md-outline-heading-2" },
      { level: 3, label: "Methods", targetId: "existing-heading" },
      { level: 4, label: "Results", targetId: "p2md-outline-heading-4" },
      { level: 5, label: "Supplement", targetId: "p2md-outline-heading-5" }
    ]);
    expect(entries.every((entry) => entry.element.dataset.p2mdOutlineTarget === entry.targetId)).toBe(true);
  });

  it("ignores empty headings and does not overwrite source ids", () => {
    const { document } = parseHTML(`
      <article>
        <h2>   </h2>
        <h2 id="section-a">Section A</h2>
        <h2>Section B</h2>
      </article>
    `);
    const article = document.querySelector("article") as unknown as HTMLElement;

    const entries = collectArticleOutlineEntries(article);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.targetId).toBe("section-a");
    expect(entries[1]?.targetId).toBe("p2md-outline-heading-3");
    expect(article.querySelector("h2")?.hasAttribute("id")).toBe(false);
  });

  it("filters proven running headers and a publisher reporting form without changing article content", () => {
    const { document } = parseHTML(`
      <article>
        <h1>Paper title</h1>
        <h2>Methods</h2>
        <p>The review may have been incomplete for some compounds.</p>
        <h2>Article</h2>
        <p>Literature review continued.</p>
        <h2>Reporting summary</h2>
        <h2>Data availability</h2>
        <h2>Article</h2>
        <h1>natureportfolio</h1>
        <p>Corresponding author(s): A. Researcher</p>
        <h2>Reporting Summary</h2>
        <h2>Statistics</h2>
        <h2>Software and code</h2>
      </article>
    `);
    const article = document.querySelector("article") as unknown as HTMLElement;

    const entries = collectArticleOutlineEntries(article);

    expect(entries.map((entry) => entry.label)).toEqual([
      "Paper title",
      "Methods",
      "Reporting summary",
      "Data availability"
    ]);
    expect(article.textContent).toContain("Literature review continued.");
    expect([...article.querySelectorAll("h2")]
      .filter((heading) => heading.textContent === "Article")
      .every((heading) => (heading as unknown as HTMLElement).dataset.p2mdOutlineExcluded === "running-header")).toBe(true);
    expect((article.querySelector("h1:last-of-type") as unknown as HTMLElement).dataset.p2mdOutlineExcluded).toBe("reporting-form");
    expect([...article.querySelectorAll("h2")]
      .find((heading) => heading.textContent === "Statistics")
      ?.getAttribute("data-p2md-outline-excluded")).toBe("reporting-form");
  });

  it("fails closed for a single Article heading or an unproven publisher heading", () => {
    const { document } = parseHTML(`
      <article>
        <h1>Paper title</h1>
        <h2>Article</h2>
        <h1>natureportfolio</h1>
        <h2>Supplementary results</h2>
      </article>
    `);
    const article = document.querySelector("article") as unknown as HTMLElement;

    expect(collectArticleOutlineEntries(article).map((entry) => entry.label)).toEqual([
      "Paper title",
      "Article",
      "natureportfolio",
      "Supplementary results"
    ]);
  });

  it("captures and restores a verified relative heading anchor after geometry changes", () => {
    const { document, window } = parseHTML(`
      <main><article><h1>Paper title</h1><h2>Methods</h2><h2>Results</h2></article></main>
    `);
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    const scroll = document.querySelector("main") as unknown as HTMLElement;
    const article = document.querySelector("article") as unknown as HTMLElement;
    const headings = [...article.querySelectorAll("h1, h2")] as unknown as HTMLElement[];
    const positions = [100, 800, 1400];
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2400 }
    });
    scroll.getBoundingClientRect = () => ({ top: 0, height: 400 } as DOMRect);
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => ({ top: positions[index] - scroll.scrollTop } as DOMRect);
    });
    scroll.scrollTop = 900;
    const host = document.createElement("aside") as unknown as HTMLElement;
    const outline = new ArticleOutline(host, scroll, "en");
    outline.setArticle(article);

    const anchor = outline.captureReadingAnchor();

    expect(anchor).toEqual({ targetId: "p2md-outline-heading-2", label: "Methods", level: 2, sectionProgress: 0.3 });
    positions.splice(0, positions.length, 100, 1000, 2200);
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 3000 });
    scroll.scrollTop = 0;
    expect(outline.restoreReadingAnchor(anchor)).toBe(true);
    expect(scroll.scrollTop).toBe(1280);
  });

  it("resets safely when a stored article anchor cannot be verified", () => {
    const { document, window } = parseHTML(`<main><article><h1>Paper title</h1></article></main>`);
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    const scroll = document.querySelector("main") as unknown as HTMLElement;
    const article = document.querySelector("article") as unknown as HTMLElement;
    const heading = article.querySelector("h1") as unknown as HTMLElement;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 }
    });
    scroll.getBoundingClientRect = () => ({ top: 0, height: 400 } as DOMRect);
    heading.getBoundingClientRect = () => ({ top: 50 - scroll.scrollTop } as DOMRect);
    const host = document.createElement("aside") as unknown as HTMLElement;
    const outline = new ArticleOutline(host, scroll, "en");
    outline.setArticle(article);
    scroll.scrollTop = 700;

    expect(outline.restoreReadingAnchor({
      targetId: "p2md-outline-heading-1",
      label: "Different paper title",
      level: 1,
      sectionProgress: 0.5
    })).toBe(false);
    expect(scroll.scrollTop).toBe(0);
  });
});
