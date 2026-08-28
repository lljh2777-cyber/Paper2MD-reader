import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { unzipSync } from "fflate";
import type { PublishedPackageDescriptor } from "./contracts";
import { MineruPrecisionApiClient, MineruRemoteError, type MineruRemoteOptions } from "./mineru-api-client";
import { normalizePackagePath } from "./package-path";
import { publishMineruPackage } from "./package-publisher";

const MAX_ARCHIVE_FILES = 1_024;
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const ALLOWED_OUTPUT = /(?:^|\/)(?:[^/]+\.md|[^/]*content_list(?:_v2)?\.json|images\/[A-Za-z0-9._/-]+\.(?:bmp|gif|jpe?g|png|webp))$/i;

export type RemoteMineruStage = "upload" | "extract" | "download" | "validate" | "publish";

export interface RemoteMineruPaths {
  jobRoot: string;
  sourcePath: string;
  extractRoot: string;
  packageStage: string;
  publishedRoot: string;
}

export interface RemoteMineruClient {
  submitPdf(sourcePath: string, filename: string, options: MineruRemoteOptions): Promise<string>;
  getBatch(batchId: string): Promise<Array<{
    state: string;
    errorCode?: string;
    zipUrl?: string;
    progress?: { extractedPages: number; totalPages: number };
  }>>;
  download(zipUrl: string): Promise<Uint8Array>;
}

export interface RemoteMineruWorkflowInput {
  packageId: string;
  filename: string;
  originalPdfPath: string;
  token: string;
  options: MineruRemoteOptions;
  paths: RemoteMineruPaths;
  contractWorkerPath: string;
  timeoutSeconds: number;
}

export interface RemoteMineruWorkflowDependencies {
  createClient?: (token: string) => RemoteMineruClient;
  publish?: typeof publishMineruPackage;
  onStage?: (stage: RemoteMineruStage, message: string) => void;
  isCancelled?: () => boolean;
  pollDelayMilliseconds?: number;
}

export class RemoteMineruCancelledError extends Error {
  constructor() {
    super("Remote MinerU extraction was cancelled locally");
    this.name = "RemoteMineruCancelledError";
  }
}

function ensureNotCancelled(isCancelled: (() => boolean) | undefined): void {
  if (isCancelled?.()) throw new RemoteMineruCancelledError();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function inspectMineruArchive(zipBytes: Uint8Array): Record<string, Uint8Array> {
  let count = 0;
  let total = 0;
  const entries = unzipSync(zipBytes, {
    filter: (entry) => {
      count += 1;
      if (count > MAX_ARCHIVE_FILES) {
        throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned an output archive that exceeds safe limits");
      }
      if (entry.name.endsWith("/")) return false;
      total += entry.originalSize;
      if (entry.originalSize < 1 || entry.originalSize > MAX_ARCHIVE_FILE_BYTES
        || total > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned an output archive that exceeds safe limits");
      }
      const path = normalizePackagePath(entry.name);
      if (!ALLOWED_OUTPUT.test(path) || path.split("/").length > 16) {
        throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned an unsupported output path");
      }
      return true;
    }
  });
  if (!Object.keys(entries).length) throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned an empty output archive");
  const normalized: Record<string, Uint8Array> = {};
  let actualTotal = 0;
  let markdownCount = 0;
  let contentListCount = 0;
  for (const [rawPath, bytes] of Object.entries(entries)) {
    const path = normalizePackagePath(rawPath);
    if (normalized[path]) throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned duplicate output paths");
    actualTotal += bytes.byteLength;
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARCHIVE_FILE_BYTES || actualTotal > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new MineruRemoteError("UNSAFE_ARCHIVE", "MinerU returned an output archive that exceeds safe limits");
    }
    const extension = extname(path).toLowerCase();
    if (extension === ".md") {
      markdownCount += 1;
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (/content_list(?:_v2)?\.json$/i.test(path)) {
      contentListCount += 1;
      try {
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new MineruRemoteError("INVALID_OUTPUT", "MinerU returned invalid structured JSON");
      }
    }
    normalized[path] = bytes;
  }
  if (markdownCount !== 1 || contentListCount !== 1) {
    throw new MineruRemoteError("INVALID_OUTPUT", "MinerU output must contain one Markdown and one content-list JSON file");
  }
  return normalized;
}

async function writeArchiveOutputs(zipBytes: Uint8Array, extractRoot: string): Promise<void> {
  const entries = inspectMineruArchive(zipBytes);
  for (const [path, bytes] of Object.entries(entries)) {
    const target = join(extractRoot, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
}

function progressMessage(progress?: { extractedPages: number; totalPages: number }): string {
  return progress?.totalPages
    ? `MinerU is extracting page ${progress.extractedPages} of ${progress.totalPages}`
    : "MinerU accepted the PDF and is extracting its contents";
}

export async function runRemoteMineruWorkflow(
  input: RemoteMineruWorkflowInput,
  dependencies: RemoteMineruWorkflowDependencies = {}
): Promise<PublishedPackageDescriptor> {
  const client = (dependencies.createClient ?? ((token) => new MineruPrecisionApiClient(token)))(input.token);
  const publish = dependencies.publish ?? publishMineruPackage;
  const onStage = dependencies.onStage ?? (() => undefined);
  const pollDelay = dependencies.pollDelayMilliseconds ?? 2_000;
  const deadline = Date.now() + input.timeoutSeconds * 1000;

  ensureNotCancelled(dependencies.isCancelled);
  await mkdir(input.paths.jobRoot, { recursive: false });
  await copyFile(input.originalPdfPath, input.paths.sourcePath, constants.COPYFILE_EXCL);
  onStage("upload", "Uploading the explicitly authorized PDF to MinerU");
  const batchId = await client.submitPdf(input.paths.sourcePath, input.filename, input.options);

  let zipUrl: string | undefined;
  while (!zipUrl) {
    ensureNotCancelled(dependencies.isCancelled);
    if (Date.now() > deadline) throw new MineruRemoteError("TIMEOUT", "MinerU extraction exceeded the configured timeout");
    const results = await client.getBatch(batchId);
    const result = results[0];
    if (!result) {
      onStage("extract", "Waiting for MinerU to start the extraction");
    } else if (result.state === "failed") {
      throw new MineruRemoteError(result.errorCode ?? "EXTRACTION_FAILED", "MinerU could not complete this extraction");
    } else if (result.state === "done") {
      if (!result.zipUrl) throw new MineruRemoteError("INVALID_OUTPUT", "MinerU completed without a result archive");
      zipUrl = result.zipUrl;
    } else {
      onStage("extract", progressMessage(result.progress));
    }
    if (!zipUrl) await delay(Math.min(pollDelay, Math.max(1, deadline - Date.now())));
  }

  ensureNotCancelled(dependencies.isCancelled);
  onStage("download", "Downloading the completed MinerU result into isolated staging");
  const zipBytes = await client.download(zipUrl);
  await mkdir(input.paths.extractRoot, { recursive: false });
  await writeArchiveOutputs(zipBytes, input.paths.extractRoot);

  ensureNotCancelled(dependencies.isCancelled);
  onStage("validate", "Building deterministic visual contracts and validating the staged package");
  return publish({
    packageId: input.packageId,
    filename: input.filename,
    sourcePath: input.paths.sourcePath,
    extractRoot: input.paths.extractRoot,
    packageStage: input.paths.packageStage,
    publishedRoot: input.paths.publishedRoot,
    mineruOptions: {
      mode: "precision-api",
      formats: ["md", "json"],
      model: input.options.model,
      language: input.options.language,
      ocr: input.options.ocr,
      formula: true,
      table: true,
      timeout_seconds: input.timeoutSeconds
    },
    contractWorkerPath: input.contractWorkerPath,
    contractTimeoutSeconds: Math.min(180, input.timeoutSeconds),
    onValidated: () => {
      ensureNotCancelled(dependencies.isCancelled);
      onStage("publish", "Validation passed; atomically publishing the immutable reading package");
    }
  });
}
