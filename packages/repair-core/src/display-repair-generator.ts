import {
  AFTER_MINERU_DISPLAY_REPAIR_VERSION,
  sha256Utf8,
  type AfterMinerUDisplayRepairContract,
  type AfterMinerUDisplayRepairEntry
} from "../../after-mineru-contract/src/index";
import {
  collectMinerUTextRecoveryCandidates,
  recoverReplacementCharacters,
  type MinerUTextRecoveryCandidate
} from "../../../src/model/mineru-text-recovery";
import { alignMinerUReplacementCharactersToPdfText } from "./pdf-text-alignment";

type UnknownRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANDIDATE_ID = /^mineru-text-(\d{6})$/;
const MAX_EVIDENCE_CHARS = 64_000;
const MAX_EVIDENCE_ITEMS = 64;
const MAX_VIEWER_PAGES = 2_048;
const MAX_BLOCKS_PER_PAGE = 512;
const MAX_VIEWER_BLOCKS = 8_192;
const MAX_ALIGNMENT_CELLS = 8_000_000;

export interface MinerUPdfTextEvidence {
  candidateId: string;
  pageIndex: number;
  text: string;
}

export interface GenerateMinerUDisplayRepairInput {
  viewerIndex: unknown;
  mineruPayload: unknown;
  sourceArticle: string;
  articleHash: string;
  mineruHash: string;
  sourcePdfHash: string;
  evidence: readonly MinerUPdfTextEvidence[];
}

export interface GeneratedMinerUDisplayRepair {
  contract: AfterMinerUDisplayRepairContract | null;
  candidateCount: number;
  repairCount: number;
  recoveredReplacementCharacterCount: number;
  abstainedCandidateIds: string[];
}

interface ViewerBinding {
  id: string;
  pageIndex: number;
  role: string;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function viewerBindings(value: unknown): Map<number, ViewerBinding[]> {
  const root = record(value);
  if (!root || root.schema_version !== 1 || !Array.isArray(root.pages) || root.pages.length > MAX_VIEWER_PAGES) {
    throw new Error("Viewer index is not a bounded v1 contract");
  }
  const bindings = new Map<number, ViewerBinding[]>();
  const blockIds = new Set<string>();
  const pageIndexes = new Set<number>();
  let blockCount = 0;
  for (const pageValue of root.pages) {
    const page = record(pageValue);
    const pageIndex = Number(page?.page_idx);
    if (!page || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || !Array.isArray(page.blocks) || page.blocks.length > MAX_BLOCKS_PER_PAGE) {
      throw new Error("Viewer index contains an invalid page");
    }
    if (pageIndexes.has(pageIndex)) throw new Error("Viewer index contains a duplicate page");
    pageIndexes.add(pageIndex);
    for (const blockValue of page.blocks) {
      blockCount += 1;
      if (blockCount > MAX_VIEWER_BLOCKS) throw new Error("Viewer index exceeds the display-repair block limit");
      const block = record(blockValue);
      const id = typeof block?.id === "string" ? block.id : "";
      const sourceIndex = Number(block?.source_index);
      const role = typeof block?.role === "string" ? block.role : "";
      if (!block || !SAFE_ID.test(id) || blockIds.has(id) || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
        throw new Error("Viewer index contains an invalid source binding");
      }
      blockIds.add(id);
      const values = bindings.get(sourceIndex) ?? [];
      values.push({ id, pageIndex, role });
      bindings.set(sourceIndex, values);
    }
  }
  return bindings;
}

function sourceIndex(candidate: MinerUTextRecoveryCandidate): number {
  const match = CANDIDATE_ID.exec(candidate.id);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid MinerU text candidate id: ${candidate.id}`);
  return parsed;
}

function passivePlaceholderSubstitution(source: string, replacement: string): boolean {
  const parts = source.split("\uFFFD");
  if (parts.length < 2 || !replacement.startsWith(parts[0])) return false;
  let cursor = parts[0].length;
  for (let index = 1; index < parts.length; index += 1) {
    const suffix = parts[index];
    const suffixIndex = suffix ? replacement.indexOf(suffix, cursor) : replacement.length;
    if (suffixIndex < cursor) return false;
    const inserted = replacement.slice(cursor, suffixIndex);
    if (
      [...inserted].length < 1
      || [...inserted].length > 4
      || !/^[\p{L}\p{N}\p{S}\p{M}]+$/u.test(inserted)
      || /[\\`*_{}[\]<>#$&]/u.test(inserted)
    ) return false;
    cursor = suffixIndex + suffix.length;
  }
  return cursor === replacement.length;
}

function evidenceByCandidate(
  candidates: readonly MinerUTextRecoveryCandidate[],
  evidence: readonly MinerUPdfTextEvidence[]
): Map<string, MinerUPdfTextEvidence> {
  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const result = new Map<string, MinerUPdfTextEvidence>();
  for (const value of evidence) {
    const candidateId = typeof value?.candidateId === "string" ? value.candidateId : "";
    const candidate = known.get(candidateId);
    if (
      !candidate
      || result.has(candidateId)
      || !Number.isSafeInteger(value?.pageIndex)
      || value.pageIndex !== candidate.pageIndex
      || typeof value?.text !== "string"
      || !value.text.trim()
      || value.text.length > MAX_EVIDENCE_CHARS
      || value.text.includes("\0")
    ) throw new Error(`PDF text evidence is not uniquely bound to ${candidateId || "a MinerU candidate"}`);
    result.set(candidateId, { candidateId, pageIndex: value.pageIndex, text: value.text });
  }
  return result;
}

/**
 * Generate a versioned display-repair sidecar from explicit PDF text evidence.
 * Missing or ambiguous evidence abstains per candidate; malformed bindings fail
 * the whole generation. The source article, MinerU payload, and PDF are never
 * modified by this function.
 */
export function generateMinerUReplacementCharacterDisplayRepair(
  input: GenerateMinerUDisplayRepairInput
): GeneratedMinerUDisplayRepair {
  if (!SHA256.test(input.articleHash) || !SHA256.test(input.mineruHash) || !SHA256.test(input.sourcePdfHash)) {
    throw new Error("Display repair generation requires exact SHA-256 source bindings");
  }
  if (!Array.isArray(input.evidence) || input.evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new Error("Display repair evidence exceeds the bounded candidate limit");
  }
  const candidates = collectMinerUTextRecoveryCandidates(input.mineruPayload, input.sourceArticle);
  if (!candidates.length) {
    if (input.evidence.length) throw new Error("PDF text evidence does not match any repair candidate");
    return {
      contract: null,
      candidateCount: 0,
      repairCount: 0,
      recoveredReplacementCharacterCount: 0,
      abstainedCandidateIds: []
    };
  }
  const evidence = evidenceByCandidate(candidates, input.evidence);
  const bindings = viewerBindings(input.viewerIndex);
  const repairs: AfterMinerUDisplayRepairEntry[] = [];
  const abstainedCandidateIds: string[] = [];
  let recoveredReplacementCharacterCount = 0;
  let remainingAlignmentCells = MAX_ALIGNMENT_CELLS;
  for (const candidate of candidates) {
    const pdfText = evidence.get(candidate.id)?.text;
    if (!pdfText) {
      abstainedCandidateIds.push(candidate.id);
      continue;
    }
    const exactContextRecovery = recoverReplacementCharacters(candidate.sourceText, pdfText);
    const alignment = exactContextRecovery
      ? undefined
      : alignMinerUReplacementCharactersToPdfText(candidate.sourceText, pdfText, remainingAlignmentCells);
    remainingAlignmentCells -= alignment?.cellsEvaluated ?? 0;
    const recovered = exactContextRecovery ?? alignment?.recovery;
    if (
      !recovered
      || recovered.recoveredCount < 1
      || recovered.text.includes("\uFFFD")
      || !passivePlaceholderSubstitution(candidate.sourceText, recovered.text)
    ) {
      abstainedCandidateIds.push(candidate.id);
      continue;
    }
    const candidateSourceIndex = sourceIndex(candidate);
    const matches = (bindings.get(candidateSourceIndex) ?? []).filter((binding) => (
      binding.pageIndex === candidate.pageIndex && ["text", "title"].includes(binding.role)
    ));
    if (matches.length !== 1) throw new Error(`MinerU candidate has no unique Viewer source binding: ${candidate.id}`);
    const replacementId = `auto-${candidate.id}`;
    repairs.push({
      id: replacementId,
      target: "article",
      source_block_id: matches[0].id,
      page_index: candidate.pageIndex,
      source_text: candidate.sourceText,
      replacement_markdown: recovered.text,
      source_text_sha256: sha256Utf8(candidate.sourceText),
      replacement_markdown_sha256: sha256Utf8(recovered.text)
    });
    recoveredReplacementCharacterCount += recovered.recoveredCount;
  }
  if (!repairs.length) {
    return {
      contract: null,
      candidateCount: candidates.length,
      repairCount: 0,
      recoveredReplacementCharacterCount: 0,
      abstainedCandidateIds
    };
  }
  const replacementCharactersBefore = repairs.reduce(
    (count, repair) => count + [...repair.source_text].filter((character) => character === "\uFFFD").length,
    0
  );
  const replacementCharactersAfter = repairs.reduce(
    (count, repair) => count + [...repair.replacement_markdown].filter((character) => character === "\uFFFD").length,
    0
  );
  return {
    contract: {
      schema_version: 1,
      algorithm_version: AFTER_MINERU_DISPLAY_REPAIR_VERSION,
      inputs: {
        article: { sha256: input.articleHash },
        mineru_result: { sha256: input.mineruHash },
        source_pdf: { sha256: input.sourcePdfHash }
      },
      repairs,
      summary: {
        repair_count: repairs.length,
        article_repair_count: repairs.length,
        caption_repair_count: 0,
        replacement_characters_before: replacementCharactersBefore,
        replacement_characters_after: replacementCharactersAfter
      }
    },
    candidateCount: candidates.length,
    repairCount: repairs.length,
    recoveredReplacementCharacterCount,
    abstainedCandidateIds
  };
}
