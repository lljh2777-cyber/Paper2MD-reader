const SOURCE_MATCH_SCORE = 3;
const WILDCARD_MATCH_SCORE = 2;
const MISMATCH_SCORE = -3;
const GAP_SCORE = -2;
const MIN_CONFIDENCE = 0.985;
const MIN_RUNNER_UP_SCORE_GAP = 12;
const MIN_RUNNER_UP_RATIO_GAP = 0.02;
const DEFAULT_MAX_CELLS = 8_000_000;
const MAX_PRIMARY_CELLS = 4_000_000;
const DIAGONAL = 1;
const UP = 2;
const LEFT = 4;
const REACHABLE = 128;
const SOURCE_FORMATTING = new Set(["$", "*", "_", "{", "}", "^", "`"]);
const ACTIVE_MARKDOWN = /[\\`*_{}[\]<>#$&]/u;
const LATEX_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω"
});

interface SourceUnit {
  canon: string;
  sourceOffset: number;
  wildcard: boolean;
}

interface PdfUnit {
  canon: string;
  originalGlyph: string;
  wildcardSafe: boolean;
}

interface PrimaryAlignment {
  bestScore: number;
  bestEnd: number;
  expectedScore: number;
  endpointCount: number;
  directions: Uint8Array;
  rowWidth: number;
}

export interface MinerUPdfTextAlignmentRecovery {
  text: string;
  recoveredCount: number;
  confidence: number;
  runnerUpConfidence: number;
}

export interface MinerUPdfTextAlignmentAttempt {
  recovery?: MinerUPdfTextAlignmentRecovery;
  cellsEvaluated: number;
  limitExceeded: boolean;
}

function normalizedUnits(value: string): string[] {
  return [...value.normalize("NFKC").toLocaleLowerCase("en-US")]
    .filter((character) => !/\s/u.test(character));
}

function canonicalSource(value: string): SourceUnit[] {
  const units: SourceUnit[] = [];
  for (let offset = 0; offset < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(offset)!);
    const characterLength = character.length;
    if (character === "\\") {
      let commandEnd = offset + characterLength;
      while (commandEnd < value.length && /[A-Za-z]/u.test(value[commandEnd])) commandEnd += 1;
      if (commandEnd > offset + characterLength) {
        const command = value.slice(offset + characterLength, commandEnd).toLocaleLowerCase("en-US");
        const symbol = LATEX_SYMBOLS[command];
        if (symbol) {
          normalizedUnits(symbol).forEach((canon) => units.push({ canon, sourceOffset: offset, wildcard: false }));
        }
        offset = commandEnd;
        continue;
      }
      offset += characterLength;
      continue;
    }
    if (/\s/u.test(character) || SOURCE_FORMATTING.has(character)) {
      offset += characterLength;
      continue;
    }
    if (character === "\uFFFD") {
      units.push({ canon: character, sourceOffset: offset, wildcard: true });
      offset += characterLength;
      continue;
    }
    normalizedUnits(character).forEach((canon) => units.push({ canon, sourceOffset: offset, wildcard: false }));
    offset += characterLength;
  }
  return units;
}

function safeWildcardGlyph(value: string, normalized: readonly string[]): boolean {
  return [...value].length === 1
    && normalized.length === 1
    && value !== "\uFFFD"
    && /^[\p{L}\p{N}\p{S}\p{M}]$/u.test(value)
    && !ACTIVE_MARKDOWN.test(value);
}

function canonicalPdf(value: string): PdfUnit[] {
  const units: PdfUnit[] = [];
  for (const originalGlyph of value) {
    const normalized = normalizedUnits(originalGlyph);
    const wildcardSafe = safeWildcardGlyph(originalGlyph, normalized);
    normalized.forEach((canon) => units.push({ canon, originalGlyph, wildcardSafe }));
  }
  return units;
}

function diagonalScore(source: SourceUnit, pdf: PdfUnit): number {
  if (source.wildcard) return WILDCARD_MATCH_SCORE;
  return source.canon === pdf.canon ? SOURCE_MATCH_SCORE : MISMATCH_SCORE;
}

function alignmentCells(sourceLength: number, pdfLength: number): number {
  return (sourceLength + 1) * (pdfLength + 1);
}

function primaryAlignment(source: readonly SourceUnit[], pdf: readonly PdfUnit[]): PrimaryAlignment {
  const rowWidth = pdf.length + 1;
  const directions = new Uint8Array((source.length + 1) * rowWidth);
  let previous = new Int32Array(rowWidth);
  let current = new Int32Array(rowWidth);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    current[0] = sourceIndex * GAP_SCORE;
    directions[sourceIndex * rowWidth] = UP;
    for (let pdfIndex = 1; pdfIndex <= pdf.length; pdfIndex += 1) {
      const diagonal = previous[pdfIndex - 1] + diagonalScore(source[sourceIndex - 1], pdf[pdfIndex - 1]);
      const up = previous[pdfIndex] + GAP_SCORE;
      const left = current[pdfIndex - 1] + GAP_SCORE;
      const best = Math.max(diagonal, up, left);
      current[pdfIndex] = best;
      directions[sourceIndex * rowWidth + pdfIndex] = (
        (diagonal === best ? DIAGONAL : 0)
        | (up === best ? UP : 0)
        | (left === best ? LEFT : 0)
      );
    }
    [previous, current] = [current, previous];
  }
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestEnd = -1;
  let endpointCount = 0;
  for (let pdfIndex = 0; pdfIndex <= pdf.length; pdfIndex += 1) {
    const score = previous[pdfIndex];
    if (score > bestScore) {
      bestScore = score;
      bestEnd = pdfIndex;
      endpointCount = 1;
    } else if (score === bestScore) {
      endpointCount += 1;
    }
  }
  return {
    bestScore,
    bestEnd,
    expectedScore: source.reduce(
      (score, unit) => score + (unit.wildcard ? WILDCARD_MATCH_SCORE : SOURCE_MATCH_SCORE),
      0
    ),
    endpointCount,
    directions,
    rowWidth
  };
}

function bestScoreOnly(source: readonly SourceUnit[], pdf: readonly PdfUnit[]): number {
  const rowWidth = pdf.length + 1;
  let previous = new Int32Array(rowWidth);
  let current = new Int32Array(rowWidth);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    current[0] = sourceIndex * GAP_SCORE;
    for (let pdfIndex = 1; pdfIndex <= pdf.length; pdfIndex += 1) {
      current[pdfIndex] = Math.max(
        previous[pdfIndex - 1] + diagonalScore(source[sourceIndex - 1], pdf[pdfIndex - 1]),
        previous[pdfIndex] + GAP_SCORE,
        current[pdfIndex - 1] + GAP_SCORE
      );
    }
    [previous, current] = [current, previous];
  }
  let best = Number.NEGATIVE_INFINITY;
  for (let pdfIndex = 0; pdfIndex <= pdf.length; pdfIndex += 1) best = Math.max(best, previous[pdfIndex]);
  return best;
}

function materializeReplacement(sourceText: string, replacements: ReadonlyMap<number, string>): string | undefined {
  let result = "";
  let replacementCount = 0;
  for (let offset = 0; offset < sourceText.length;) {
    const character = String.fromCodePoint(sourceText.codePointAt(offset)!);
    if (character === "\uFFFD") {
      const replacement = replacements.get(offset);
      if (!replacement) return undefined;
      result += replacement;
      replacementCount += 1;
    } else {
      result += character;
    }
    offset += character.length;
  }
  return replacementCount === replacements.size && !result.includes("\uFFFD") ? result : undefined;
}

function uniqueOptimalReplacements(
  source: readonly SourceUnit[],
  pdf: readonly PdfUnit[],
  primary: PrimaryAlignment
): { bestStart: number; replacements: Map<number, string> } | undefined {
  const choices = new Map<number, Set<string>>();
  const reachable = primary.directions;
  reachable[source.length * primary.rowWidth + primary.bestEnd] |= REACHABLE;
  for (let sourceIndex = source.length; sourceIndex > 0; sourceIndex -= 1) {
    for (let pdfIndex = primary.bestEnd; pdfIndex >= 0; pdfIndex -= 1) {
      const cellIndex = sourceIndex * primary.rowWidth + pdfIndex;
      const cell = reachable[cellIndex];
      if (!(cell & REACHABLE)) continue;
      const directions = cell & (DIAGONAL | UP | LEFT);
      const sourceUnit = source[sourceIndex - 1];
      if (!directions || sourceUnit.wildcard && (directions & UP)) return undefined;
      if (directions & DIAGONAL) {
        if (pdfIndex <= 0) return undefined;
        const pdfUnit = pdf[pdfIndex - 1];
        if (sourceUnit.wildcard) {
          if (!pdfUnit.wildcardSafe) return undefined;
          const glyphs = choices.get(sourceUnit.sourceOffset) ?? new Set<string>();
          glyphs.add(pdfUnit.originalGlyph);
          if (glyphs.size > 1) return undefined;
          choices.set(sourceUnit.sourceOffset, glyphs);
        }
        reachable[(sourceIndex - 1) * primary.rowWidth + pdfIndex - 1] |= REACHABLE;
      }
      if (directions & UP) {
        reachable[(sourceIndex - 1) * primary.rowWidth + pdfIndex] |= REACHABLE;
      }
      if (directions & LEFT) {
        if (pdfIndex <= 0) return undefined;
        reachable[cellIndex - 1] |= REACHABLE;
      }
    }
  }
  const starts: number[] = [];
  for (let pdfIndex = 0; pdfIndex <= primary.bestEnd; pdfIndex += 1) {
    if (reachable[pdfIndex] & REACHABLE) starts.push(pdfIndex);
  }
  if (starts.length !== 1) return undefined;
  const replacements = new Map<number, string>();
  for (const unit of source) {
    if (!unit.wildcard || replacements.has(unit.sourceOffset)) continue;
    const glyphs = choices.get(unit.sourceOffset);
    if (!glyphs || glyphs.size !== 1) return undefined;
    replacements.set(unit.sourceOffset, [...glyphs][0]);
  }
  return { bestStart: starts[0], replacements };
}

/**
 * Align one immutable MinerU source block against a bounded PDF page text
 * layer. Acceptance requires complete source coverage, a unique best endpoint
 * a high score, a distant runner-up, and one identical safe PDF glyph across
 * every optimal path for each U+FFFD. Only those source offsets are
 * materialized in the result.
 */
export function alignMinerUReplacementCharactersToPdfText(
  sourceText: string,
  pdfText: string,
  maxCells = DEFAULT_MAX_CELLS
): MinerUPdfTextAlignmentAttempt {
  const source = canonicalSource(sourceText);
  const pdf = canonicalPdf(pdfText);
  const wildcardCount = source.filter((unit) => unit.wildcard).length;
  if (!source.length || !pdf.length || !wildcardCount) {
    return { cellsEvaluated: 0, limitExceeded: false };
  }
  const primaryCells = alignmentCells(source.length, pdf.length);
  if (primaryCells > MAX_PRIMARY_CELLS || primaryCells > maxCells) {
    return { cellsEvaluated: 0, limitExceeded: true };
  }
  const primary = primaryAlignment(source, pdf);
  let cellsEvaluated = primaryCells;
  if (
    primary.endpointCount !== 1
    || primary.bestEnd <= 0
    || primary.expectedScore <= 0
    || primary.bestScore / primary.expectedScore < MIN_CONFIDENCE
  ) return { cellsEvaluated, limitExceeded: false };

  const optimal = uniqueOptimalReplacements(source, pdf, primary);
  if (!optimal) return { cellsEvaluated, limitExceeded: false };
  const { bestStart, replacements } = optimal;
  if (replacements.size !== wildcardCount) return { cellsEvaluated, limitExceeded: false };

  const runnerCells = alignmentCells(source.length, bestStart)
    + alignmentCells(source.length, pdf.length - primary.bestEnd);
  if (cellsEvaluated + runnerCells > maxCells) return { cellsEvaluated, limitExceeded: true };
  const runnerUpScore = Math.max(
    bestScoreOnly(source, pdf.slice(0, bestStart)),
    bestScoreOnly(source, pdf.slice(primary.bestEnd))
  );
  cellsEvaluated += runnerCells;
  const requiredGap = Math.max(
    MIN_RUNNER_UP_SCORE_GAP,
    Math.ceil(primary.expectedScore * MIN_RUNNER_UP_RATIO_GAP)
  );
  if (primary.bestScore - runnerUpScore < requiredGap) {
    return { cellsEvaluated, limitExceeded: false };
  }
  const text = materializeReplacement(sourceText, replacements);
  if (!text) return { cellsEvaluated, limitExceeded: false };
  return {
    recovery: {
      text,
      recoveredCount: wildcardCount,
      confidence: primary.bestScore / primary.expectedScore,
      runnerUpConfidence: runnerUpScore / primary.expectedScore
    },
    cellsEvaluated,
    limitExceeded: false
  };
}
