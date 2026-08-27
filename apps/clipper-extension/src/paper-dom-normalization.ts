function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function figureBoundary(element: Element): Element | null {
  return element.closest('[data-container-section="figure"]') ?? element.closest("figure");
}

function referencedDescriptions(root: ParentNode, figure: Element): Element[] {
  const descriptions: Element[] = [];
  for (const image of figure.querySelectorAll("img[aria-describedby]")) {
    const ids = (image.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const candidate = root.querySelector(`#${cssEscape(id)}`);
      if (candidate && figureBoundary(candidate) === figureBoundary(figure)) descriptions.push(candidate);
    }
  }
  return descriptions;
}

function descriptionCandidates(root: ParentNode, figure: Element): Element[] {
  return [
    ...figure.querySelectorAll('[data-test="bottom-caption"], .c-article-section__figure-description'),
    ...referencedDescriptions(root, figure)
  ];
}

/**
 * Publisher pages such as nature.com keep the figure title in <figcaption> but
 * put the descriptive caption in a sibling element. Defuddle otherwise emits
 * only the short title. This moves only explicitly figure-bound description
 * nodes into the caption in an isolated document used for extraction.
 */
export function mergeSeparatedFigureCaptions(document: Document): void {
  for (const figure of document.querySelectorAll("figure")) {
    const candidates = [...new Set(descriptionCandidates(document, figure))];
    if (!candidates.length) continue;

    let caption = figure.querySelector(":scope > figcaption") ?? figure.querySelector("figcaption");
    if (!caption) {
      caption = document.createElement("figcaption");
      figure.prepend(caption);
    }

    for (const description of candidates) {
      if (caption.contains(description)) continue;
      const descriptionText = normalizedText(description.textContent);
      if (!descriptionText) continue;
      const captionText = normalizedText(caption.textContent);
      if (captionText.includes(descriptionText)) {
        description.remove();
        continue;
      }
      description.removeAttribute("hidden");
      description.removeAttribute("aria-hidden");
      caption.append(description);
    }
  }
}

export function clonePaperDocumentForExtraction(source: Document): Document {
  const clone = new DOMParser().parseFromString(source.documentElement.outerHTML, "text/html");
  const base = clone.createElement("base");
  base.href = source.baseURI;
  clone.head.prepend(base);
  mergeSeparatedFigureCaptions(clone);
  return clone;
}
