import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { collectArticleOutlineEntries } from "../src/render/article-outline";

describe("article outline", () => {
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
});
