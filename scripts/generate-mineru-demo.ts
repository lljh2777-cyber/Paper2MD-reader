import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { MineruPrecisionApiClient } from "../apps/processing-service/src/mineru-api-client";
import {
  inspectMinerUArchive,
  MINERU_ARCHIVE_READER_LIMITS
} from "../src/model/mineru-archive";

const POLL_INTERVAL_MILLISECONDS = 2_000;
const EXTRACTION_TIMEOUT_MILLISECONDS = 15 * 60_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function within(parent: string, candidate: string): boolean {
  const local = relative(parent, candidate);
  return Boolean(local) && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const demoRoot = resolve(repositoryRoot, "sites-reader", "public", "demo");
  const sourcePath = resolve(repositoryRoot, argument("--source"));
  const outputPath = resolve(repositoryRoot, argument("--output"));
  if (!within(demoRoot, sourcePath) || !within(demoRoot, outputPath)) {
    throw new Error("Demo source and output must stay inside sites-reader/public/demo.");
  }
  if (!sourcePath.toLowerCase().endsWith(".pdf") || !outputPath.toLowerCase().endsWith(".mineru.zip")) {
    throw new Error("Expected a PDF source and a .mineru.zip output.");
  }

  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 5 || sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new Error("The demo PDF is unavailable or exceeds the maintainer safety limit.");
  }
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  if (new TextDecoder("ascii").decode(sourceBytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The demo source is not a PDF.");
  }

  const token = process.env.MINERU_TOKEN?.trim();
  if (!token) throw new Error("MINERU_TOKEN is required in the current process environment.");
  const client = new MineruPrecisionApiClient(token);
  console.log(`Submitting ${basename(sourcePath)} to MinerU (source SHA-256 ${sha256(sourceBytes)}).`);
  const batchId = await client.submitPdf(sourcePath, basename(sourcePath), {
    model: "vlm",
    language: "en",
    ocr: false,
    formula: true,
    table: true
  }, () => console.log("MinerU issued a signed upload destination; uploading the authorized PDF."));

  const deadline = Date.now() + EXTRACTION_TIMEOUT_MILLISECONDS;
  let zipUrl: string | undefined;
  while (!zipUrl) {
    if (Date.now() >= deadline) throw new Error("MinerU extraction timed out.");
    const result = (await client.getBatch(batchId))[0];
    if (result?.state === "failed") throw new Error(`MinerU extraction failed (${result.errorCode ?? "unknown"}).`);
    if (result?.state === "done") {
      if (!result.zipUrl) throw new Error("MinerU completed without a result archive.");
      zipUrl = result.zipUrl;
      break;
    }
    const progress = result?.progress;
    console.log(progress?.totalPages
      ? `MinerU extraction: ${progress.extractedPages}/${progress.totalPages} pages.`
      : "MinerU extraction is in progress.");
    await delay(POLL_INTERVAL_MILLISECONDS);
  }

  const zipBytes = await client.download(zipUrl);
  const inspection = inspectMinerUArchive(zipBytes, MINERU_ARCHIVE_READER_LIMITS);
  await writeFile(outputPath, zipBytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    output: relative(repositoryRoot, outputPath).replaceAll("\\", "/"),
    bytes: zipBytes.byteLength,
    sha256: sha256(zipBytes),
    ...inspection
  }, null, 2));
}

await main();
