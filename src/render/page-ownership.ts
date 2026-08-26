const READING_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table";

function normalizedText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** Materialize inline page markers onto visible reading blocks without touching source Markdown. */
export function materializeReaderPageOwnership(article: HTMLElement): HTMLElement[] {
  const blocks = [...article.querySelectorAll<HTMLElement>(READING_BLOCK_SELECTOR)]
    .filter((block) => Boolean(normalizedText(block.textContent)));
  if (!blocks.length) return [];
  blocks.forEach((block) => {
    delete block.dataset.p2mdPage;
    delete block.dataset.p2mdPageOwner;
  });
  const blockIndex = (marker: HTMLElement): number => {
    const containing = marker.closest<HTMLElement>(READING_BLOCK_SELECTOR);
    if (containing && normalizedText(containing.textContent)) return blocks.indexOf(containing);
    return blocks.findIndex((candidate) => Boolean(marker.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING));
  };
  let previous = -1;
  for (const marker of article.querySelectorAll<HTMLElement>(".p2md-page-anchor[data-p2md-page]")) {
    const page = Number(marker.dataset.p2mdPage || 0);
    const index = blockIndex(marker);
    marker.remove();
    if (page <= 0 || index <= previous) continue;
    blocks[index].dataset.p2mdPage = String(page);
    previous = index;
  }
  let owner = 1;
  blocks.forEach((block) => {
    const boundary = Number(block.dataset.p2mdPage || 0);
    if (boundary > 0) owner = boundary;
    block.dataset.p2mdPageOwner = String(owner);
  });
  return blocks;
}
