import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FigurePresentation, FigureSidebar } from "../src/render/figure-sidebar";

afterEach(() => vi.unstubAllGlobals());

describe("figure sidebar layout", () => {
  it("keeps the image region in normal flow when a long caption makes the stage scroll", () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    const imageButtonRule = stylesheet.match(/\.p2md-figure-image-button\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(imageButtonRule).toMatch(/flex:\s*0\s+0\s+auto\s*;/);
  });

  it("preserves the thumbnail rail position across redraws and reveals a newly selected visual", () => {
    const { document, window } = parseHTML("<html><body><aside id=figures></aside></body></html>");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const host = document.querySelector<HTMLElement>("#figures")!;
    const figures: FigurePresentation[] = Array.from({ length: 16 }, (_, index) => ({
      id: `figure-${index + 1}`,
      label: `Figure ${index + 1}`,
      kind: "figure",
      imageSrc: "",
      available: false
    }));
    const sidebar = new FigureSidebar(host, { onOpenImage: vi.fn() });
    sidebar.setFigures(figures);
    scrollIntoView.mockClear();

    const initialRail = host.querySelector<HTMLElement>(".p2md-thumbnail-rail")!;
    initialRail.scrollTop = 312;
    sidebar.setFollowing(false);

    const redrawnRail = host.querySelector<HTMLElement>(".p2md-thumbnail-rail")!;
    expect(redrawnRail).not.toBe(initialRail);
    expect(redrawnRail.scrollTop).toBe(312);
    expect(scrollIntoView).not.toHaveBeenCalled();

    expect(sidebar.navigateTo("figure-14")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});
