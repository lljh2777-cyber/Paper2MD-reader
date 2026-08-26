import { NormalizedBBox } from "./reader-contract";

export interface MinerUTextRecoveryCandidate {
  id: string;
  pageIndex: number;
  bbox: NormalizedBBox;
  sourceText: string;
}

export interface MinerUTextRecoveryResult {
  text: string;
  recoveredCount: number;
}

const MAX_RECOVERY_CANDIDATES = 64;
const MAX_RECOVERY_BLOCK_CHARS = 20_000;
const MAX_REPLACEMENTS_PER_BLOCK = 32;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedBBox(value: unknown): NormalizedBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = value as number[];
  const scale = Math.max(...value.map((item) => Math.abs(item as number))) <= 1 ? 1 : 1000;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > scale || y1 > scale) return undefined;
  return { x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale };
}

function uniqueOccurrence(source: string, value: string): boolean {
  const first = source.indexOf(value);
  return first >= 0 && source.indexOf(value, first + value.length) < 0;
}

export function collectMinerUTextRecoveryCandidates(raw: unknown, markdown: string): MinerUTextRecoveryCandidate[] {
  if (!Array.isArray(raw)) return [];
  const candidates: MinerUTextRecoveryCandidate[] = [];
  let sourceIndex = 0;
  const visit = (value: unknown, pageFallback?: number) => {
    const item = record(value);
    if (!item) return;
    const text = typeof item.text === "string" ? item.text : "";
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const pageIndex = Number.isInteger(item.page_idx) && Number(item.page_idx) >= 0
      ? Number(item.page_idx)
      : pageFallback;
    const bbox = normalizedBBox(item.bbox);
    const replacementCount = [...text].filter((character) => character === "\uFFFD").length;
    if (
      candidates.length < MAX_RECOVERY_CANDIDATES
      && type === "text"
      && text.length <= MAX_RECOVERY_BLOCK_CHARS
      && replacementCount > 0
      && replacementCount <= MAX_REPLACEMENTS_PER_BLOCK
      && pageIndex !== undefined
      && bbox
      && uniqueOccurrence(markdown, text)
    ) {
      candidates.push({
        id: `mineru-text-${sourceIndex.toString().padStart(6, "0")}`,
        pageIndex,
        bbox,
        sourceText: text
      });
    }
    sourceIndex += 1;
  };
  if (raw.some(Array.isArray)) {
    raw.forEach((page, pageIndex) => {
      if (Array.isArray(page)) page.forEach((value) => visit(value, pageIndex));
    });
  } else {
    raw.forEach((value) => visit(value));
  }
  return candidates;
}

function regexContext(value: string): string {
  return [...value.replace(/\s+/gu, "")]
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

function safeRecoveredSymbol(value: string): string | undefined {
  let compact = value.replace(/\s+/gu, "");
  const points = [...compact];
  if (points.length >= 2 && points.length % 2 === 0) {
    const half = points.length / 2;
    if (points.slice(0, half).join("") === points.slice(half).join("")) compact = points.slice(0, half).join("");
  }
  const collapsed = [...compact];
  if (collapsed.length < 1 || collapsed.length > 4 || !/^[\p{L}\p{N}\p{S}\p{M}]+$/u.test(compact)) return undefined;
  return compact;
}

function recoverOne(source: string, placeholderIndex: number, pdfText: string): string | undefined {
  const leftSource = [...source.slice(Math.max(0, placeholderIndex - 96), placeholderIndex).replace(/\s+/gu, "")];
  const rightSource = [...source.slice(placeholderIndex + 1, placeholderIndex + 97).replace(/\s+/gu, "")];
  for (const length of [32, 24, 16, 12, 10, 8]) {
    const left = leftSource.slice(-length).join("");
    const right = rightSource.slice(0, length).join("");
    if (left.length < length || right.length < length) continue;
    const expression = new RegExp(`${regexContext(left)}\\s*([\\p{L}\\p{N}\\p{S}\\p{M}\\s]{1,12}?)\\s*${regexContext(right)}`, "gu");
    const matches = [...pdfText.matchAll(expression)];
    if (matches.length !== 1) continue;
    const recovered = safeRecoveredSymbol(matches[0][1]);
    if (recovered) return recovered;
  }
  const rawRight = source.slice(placeholderIndex + 1, placeholderIndex + 97).trimStart();
  if (/^[)\]}]/u.test(rawRight)) {
    const right = [...rawRight.replace(/\s+/gu, "")].slice(0, 28).join("");
    if (right.length >= 16) {
      const expression = new RegExp(`([\\p{L}\\p{N}\\p{S}\\p{M}\\s]{1,12}?)\\s*${regexContext(right)}`, "gu");
      const matches = [...pdfText.matchAll(expression)];
      if (matches.length === 1) return safeRecoveredSymbol(matches[0][1]);
    }
  }
  return undefined;
}

export function recoverReplacementCharacters(sourceText: string, pdfText: string): MinerUTextRecoveryResult | undefined {
  const placeholderIndexes: number[] = [];
  for (let index = sourceText.indexOf("\uFFFD"); index >= 0; index = sourceText.indexOf("\uFFFD", index + 1)) {
    placeholderIndexes.push(index);
  }
  if (!placeholderIndexes.length) return { text: sourceText, recoveredCount: 0 };
  const recovered = placeholderIndexes.map((index) => recoverOne(sourceText, index, pdfText));
  if (recovered.some((value) => !value)) return undefined;
  let cursor = 0;
  let text = "";
  placeholderIndexes.forEach((index, ordinal) => {
    text += sourceText.slice(cursor, index) + recovered[ordinal];
    cursor = index + 1;
  });
  text += sourceText.slice(cursor);
  return { text, recoveredCount: recovered.length };
}

export function applyRecoveredText(article: string, sourceText: string, recoveredText: string): string | undefined {
  if (sourceText === recoveredText || !uniqueOccurrence(article, sourceText)) return undefined;
  return article.replace(sourceText, recoveredText);
}
