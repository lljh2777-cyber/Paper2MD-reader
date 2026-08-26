type UnknownRecord = Record<string, unknown>;

export interface MinerUPageBoundary {
  pageNumber: number;
  candidates: string[];
}

export interface MinerUPageMap {
  pageCount: number;
  boundaries: MinerUPageBoundary[];
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function flatRecords(payload: unknown): UnknownRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => Array.isArray(value) ? value : [value])
    .map(record)
    .filter((value): value is UnknownRecord => Boolean(value));
}

function sourceText(value: UnknownRecord | undefined): string[] {
  if (!value) return [];
  return [value.text, value.table_body, value.table_body_html, value.html]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length >= 8 && item.length <= 24_000);
}

function uniqueIn(value: string, source: string): boolean {
  const first = source.indexOf(value);
  return first >= 0 && source.indexOf(value, first + value.length) < 0;
}

export function buildMinerUPageMap(
  sourceMarkdown: string,
  mineruPayload: unknown,
  viewerIndex: unknown,
  expectedHashes?: { article: string; mineru: string }
): MinerUPageMap | undefined {
  const viewer = record(viewerIndex);
  if (expectedHashes) {
    const inputs = record(viewer?.inputs);
    const article = record(inputs?.article);
    const mineru = record(inputs?.mineru_result);
    if (article?.sha256 !== expectedHashes.article || mineru?.sha256 !== expectedHashes.mineru) return undefined;
  }
  const pages = Array.isArray(viewer?.pages)
    ? viewer.pages.map(record).filter((page): page is UnknownRecord => Boolean(page))
    : [];
  if (!pages.length) return undefined;
  const raw = flatRecords(mineruPayload);
  const boundaries = pages
    .filter((page) => Number.isInteger(page.page_idx) && Number(page.page_idx) >= 0)
    .sort((left, right) => Number(left.page_idx) - Number(right.page_idx))
    .map((page): MinerUPageBoundary => {
      const blocks = Array.isArray(page.blocks)
        ? page.blocks.map(record).filter((block): block is UnknownRecord => Boolean(block))
        : [];
      const candidates = blocks
        .sort((left, right) => Number(left.page_order) - Number(right.page_order))
        .flatMap((block) => sourceText(raw[Number(block.source_index)]))
        .filter((text, index, values) => values.indexOf(text) === index && uniqueIn(text, sourceMarkdown));
      return { pageNumber: Number(page.page_idx) + 1, candidates };
    });
  const pageCount = Math.max(0, ...boundaries.map((boundary) => boundary.pageNumber));
  return pageCount ? { pageCount, boundaries } : undefined;
}

export function injectMinerUPageAnchors(projectedMarkdown: string, map: MinerUPageMap | undefined): string {
  if (!map?.boundaries.length) return projectedMarkdown;
  const insertions: Array<{ pageNumber: number; position: number }> = [];
  let previous = -1;
  for (const boundary of map.boundaries) {
    const position = boundary.candidates
      .map((candidate) => {
        const found = projectedMarkdown.indexOf(candidate);
        return found > previous && projectedMarkdown.indexOf(candidate, found + candidate.length) < 0 ? found : -1;
      })
      .find((candidate) => candidate >= 0)
      ?? (boundary.pageNumber === 1 && previous < 0 ? 0 : -1);
    if (position < 0) continue;
    insertions.push({ pageNumber: boundary.pageNumber, position });
    previous = position;
  }
  return insertions.sort((left, right) => right.position - left.position).reduce((markdown, insertion) => {
    const anchor = `<span class="p2md-page-anchor" data-p2md-page="${insertion.pageNumber}" aria-hidden="true"></span>`;
    return `${markdown.slice(0, insertion.position)}${anchor}${markdown.slice(insertion.position)}`;
  }, projectedMarkdown);
}
