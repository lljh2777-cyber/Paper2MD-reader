import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { prepareMinerUVisualReview } from "../../../src/model/mineru-visual-review";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  buildMineruVisualRepair,
  extractMarkdownImageOccurrences
} from "./reader-contract-generator";

const MAX_ARTICLE_BYTES = 64 * 1024 * 1024;
const MAX_MINERU_JSON_BYTES = 64 * 1024 * 1024;
const MAX_CONTRACT_WORKER_TIMEOUT_SECONDS = 180;
const MAX_WORKER_ERROR_CHARS = 4096;

export interface ReaderContractSummary {
  viewer: Record<string, unknown>;
  repair: Record<string, unknown>;
  candidates: Record<string, unknown>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function summary(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.summary;
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

function readerContractSummary(value: unknown): ReaderContractSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recordValue = value as Record<string, unknown>;
  const asRecord = (item: unknown): Record<string, unknown> | undefined =>
    item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
  const viewer = asRecord(recordValue.viewer);
  const repair = asRecord(recordValue.repair);
  const candidates = asRecord(recordValue.candidates);
  return viewer && repair && candidates ? { viewer, repair, candidates } : undefined;
}

export async function buildReaderContractsInProcess(input: { packageRoot: string }): Promise<ReaderContractSummary> {
  const articlePath = join(input.packageRoot, "article.md");
  const mineruPath = join(input.packageRoot, "mineru-result.json");
  const extractionRoot = join(input.packageRoot, "_extraction");
  const sourcePdfPath = join(extractionRoot, "source.pdf");
  const [articleInfo, mineruInfo, sourceInfo] = await Promise.all([
    lstat(articlePath).catch(() => undefined),
    lstat(mineruPath).catch(() => undefined),
    lstat(sourcePdfPath).catch(() => undefined)
  ]);
  if (!articleInfo?.isFile() || articleInfo.isSymbolicLink() || articleInfo.size < 1 || articleInfo.size > MAX_ARTICLE_BYTES) {
    throw new Error("Missing, unsafe, or oversized staged package input: article.md");
  }
  if (!mineruInfo?.isFile() || mineruInfo.isSymbolicLink() || mineruInfo.size < 1 || mineruInfo.size > MAX_MINERU_JSON_BYTES) {
    throw new Error("Missing, unsafe, or oversized staged package input: mineru-result.json");
  }
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1) {
    throw new Error("Missing or unsafe staged package input: source.pdf");
  }
  const [articleBytes, mineruBytes] = await Promise.all([readFile(articlePath), readFile(mineruPath)]);
  const article = decodeUtf8(articleBytes, "article.md");
  const mineruText = decodeUtf8(mineruBytes, "mineru-result.json");
  let mineruPayload: unknown;
  try {
    mineruPayload = JSON.parse(mineruText) as unknown;
  } catch {
    throw new Error("mineru-result.json is not valid JSON");
  }
  const articleHash = sha256(articleBytes);
  const mineruHash = sha256(mineruBytes);
  const viewerIndex = buildMineruViewerIndex(
    mineruPayload,
    extractMarkdownImageOccurrences(article),
    { article: articleHash, mineru_result: mineruHash },
    { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
  );
  const visualRepair = buildMineruVisualRepair(viewerIndex);
  const visualCandidates = buildMineruVisualCandidates(viewerIndex, visualRepair);
  const candidateBytes = jsonBytes(visualCandidates);
  const prepared = await prepareMinerUVisualReview({
    candidatePackage: visualCandidates,
    viewerIndex,
    visualRepair,
    articleHash,
    mineruHash,
    mineruPayload,
    articleMarkdown: article,
    sourcePdfPath: "_extraction/source.pdf",
    candidateFileHash: sha256(candidateBytes)
  });
  if (!prepared.review || prepared.diagnostics.some((item) => item.code === "mineru-visual-review-invalid")) {
    throw new Error("Generated visual review contracts failed deterministic validation");
  }
  await Promise.all([
    writeFile(join(extractionRoot, "viewer-index.json"), jsonBytes(viewerIndex), { flag: "wx", mode: 0o600 }),
    writeFile(join(extractionRoot, "visual-repair.json"), jsonBytes(visualRepair), { flag: "wx", mode: 0o600 }),
    writeFile(join(extractionRoot, "visual-candidates.json"), candidateBytes, { flag: "wx", mode: 0o600 })
  ]);
  return { viewer: summary(viewerIndex), repair: summary(visualRepair), candidates: summary(visualCandidates) };
}

export async function buildReaderContracts(input: {
  packageRoot: string;
  timeoutSeconds: number;
  workerPath: string;
}): Promise<ReaderContractSummary> {
  const timeoutMilliseconds = Math.max(10, Math.min(input.timeoutSeconds, MAX_CONTRACT_WORKER_TIMEOUT_SECONDS)) * 1000;
  return await new Promise<ReaderContractSummary>((resolvePromise, reject) => {
    const worker = new Worker(input.workerPath, {
      workerData: { packageRoot: input.packageRoot },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error("Reader contract builder timed out"));
      });
    }, timeoutMilliseconds);
    worker.once("message", (message: unknown) => {
      const payload = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : {};
      if (payload.ok === true) {
        const result = readerContractSummary(payload.result);
        finish(() => result ? resolvePromise(result) : reject(new Error("Reader contract worker returned an invalid summary")));
        return;
      }
      const detail = typeof payload.error === "string" ? payload.error.slice(0, MAX_WORKER_ERROR_CHARS) : "unknown error";
      finish(() => reject(new Error(`Reader contract builder failed: ${detail}`)));
    });
    worker.once("error", (error) => {
      finish(() => reject(new Error(`Reader contract worker failed: ${error.message.slice(0, MAX_WORKER_ERROR_CHARS)}`)));
    });
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`Reader contract worker exited before completion (${code})`)));
    });
  });
}
