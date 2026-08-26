import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { installMarkdownMath } from "../src/render/markdown-math";

describe("Markdown math parsing", () => {
  it("turns inline and display LaTeX into inert render placeholders", () => {
    const markdown = new MarkdownIt({ html: true });
    installMarkdownMath(markdown);
    const html = markdown.render("Inline $x_i^2$ here.\n\n$$ \\frac{a}{b} $$\n");

    expect(html).toContain("p2md-math-source");
    expect(html).toContain("data-p2md-math=\"x_i%5E2\"");
    expect(html).toContain("p2md-math-block");
    expect(html).not.toContain("$$");
  });

  it("does not treat currency or unclosed delimiters as math", () => {
    const markdown = new MarkdownIt();
    installMarkdownMath(markdown);
    const html = markdown.render("The price is $ 10 and this is $unclosed.");
    expect(html).not.toContain("p2md-math-source");
  });
});
