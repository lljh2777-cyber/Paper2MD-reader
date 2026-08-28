import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build as buildBundle } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  buildMineruVisualRepair,
  extractMarkdownImageOccurrences
} from "../apps/processing-service/src/reader-contract-generator";
import { buildReaderContracts } from "../apps/processing-service/src/reader-contract-builder";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const python = process.platform === "win32" ? "D:\\python\\python.exe" : "python3";
const pythonAvailable = process.platform !== "win32" || existsSync(python);
const contractNames = ["viewer-index.json", "visual-repair.json", "visual-candidates.json"] as const;
let contractWorkerPath = "";

beforeAll(async () => {
  const workerRoot = await mkdtemp(join(tmpdir(), "paper2md-contract-worker-"));
  contractWorkerPath = join(workerRoot, "reader-contract-worker.mjs");
  await buildBundle({
    entryPoints: [join(repositoryRoot, "apps", "processing-service", "src", "reader-contract-worker.ts")],
    outfile: contractWorkerPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false
  });
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("TypeScript reader-contract generator", () => {
  it("matches the frozen Python viewer-index output", async () => {
    const [article, mineruText, expectedViewer, expectedRepair, expectedCandidates] = await Promise.all([
      readFile(join(repositoryRoot, "test", "mineru-package", "paper.md"), "utf8"),
      readFile(join(repositoryRoot, "test", "mineru-package", "paper_content_list.json"), "utf8"),
      readJson(join(repositoryRoot, "test", "fixtures", "reader-contract-golden", "viewer-index.json")),
      readJson(join(repositoryRoot, "test", "fixtures", "reader-contract-golden", "visual-repair.json")),
      readJson(join(repositoryRoot, "test", "fixtures", "reader-contract-golden", "visual-candidates.json"))
    ]);
    const actualViewer = buildMineruViewerIndex(
      JSON.parse(mineruText) as unknown,
      extractMarkdownImageOccurrences(article),
      { article: sha256(article), mineru_result: sha256(mineruText) },
      { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
    );
    expect(actualViewer).toEqual(expectedViewer);
    const actualRepair = buildMineruVisualRepair(actualViewer);
    expect(actualRepair).toEqual(expectedRepair);
    expect(buildMineruVisualCandidates(actualViewer, actualRepair)).toEqual(expectedCandidates);
  });

  it("matches Python for an automatic panel group and a complete cross-page caption", async () => {
    const fixtureRoot = join(repositoryRoot, "test", "fixtures", "reader-contract-complex");
    const [article, mineruText, expectedViewer, expectedRepair, expectedCandidates] = await Promise.all([
      readFile(join(fixtureRoot, "article.md"), "utf8"),
      readFile(join(fixtureRoot, "mineru-result.json"), "utf8"),
      readJson(join(fixtureRoot, "expected-viewer-index.json")),
      readJson(join(fixtureRoot, "expected-visual-repair.json")),
      readJson(join(fixtureRoot, "expected-visual-candidates.json"))
    ]);
    const viewer = buildMineruViewerIndex(
      JSON.parse(mineruText) as unknown,
      extractMarkdownImageOccurrences(article),
      { article: sha256(article), mineru_result: sha256(mineruText) },
      { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
    );
    expect(viewer).toEqual(expectedViewer);
    const repair = buildMineruVisualRepair(viewer);
    expect(repair).toEqual(expectedRepair);
    expect(buildMineruVisualCandidates(viewer, repair)).toEqual(expectedCandidates);
  });

  it("matches Python for review and partial-caption candidate packets including canonical hashes", async () => {
    const fixtureRoot = join(repositoryRoot, "test", "fixtures", "reader-contract-review");
    const [article, mineruText, expectedViewer, expectedRepair, expectedCandidates] = await Promise.all([
      readFile(join(fixtureRoot, "article.md"), "utf8"),
      readFile(join(fixtureRoot, "mineru-result.json"), "utf8"),
      readJson(join(fixtureRoot, "expected-viewer-index.json")),
      readJson(join(fixtureRoot, "expected-visual-repair.json")),
      readJson(join(fixtureRoot, "expected-visual-candidates.json"))
    ]);
    const viewer = buildMineruViewerIndex(
      JSON.parse(mineruText) as unknown,
      extractMarkdownImageOccurrences(article),
      { article: sha256(article), mineru_result: sha256(mineruText) },
      { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
    );
    const repair = buildMineruVisualRepair(viewer);
    expect(viewer).toEqual(expectedViewer);
    expect(repair).toEqual(expectedRepair);
    expect(buildMineruVisualCandidates(viewer, repair)).toEqual(expectedCandidates);
  });

  it("writes the validated derived contracts without launching Python", async () => {
    const fixtureRoot = join(repositoryRoot, "test", "fixtures", "reader-contract-review");
    const packageRoot = await mkdtemp(join(tmpdir(), "paper2md-typescript-contracts-"));
    const extractionRoot = join(packageRoot, "_extraction");
    await mkdir(extractionRoot);
    await Promise.all([
      copyFile(join(fixtureRoot, "article.md"), join(packageRoot, "article.md")),
      copyFile(join(fixtureRoot, "mineru-result.json"), join(packageRoot, "mineru-result.json")),
      writeFile(join(extractionRoot, "source.pdf"), "%PDF-1.4\n%%EOF\n", { encoding: "ascii", flag: "wx" })
    ]);
    let eventLoopTicked = false;
    const buildPromise = buildReaderContracts({ packageRoot, workerPath: contractWorkerPath, timeoutSeconds: 30 });
    setImmediate(() => { eventLoopTicked = true; });
    await expect(buildPromise).resolves.toMatchObject({
      viewer: { source_element_count: 5 },
      repair: { group_count: 1, review_group_count: 1, partial_caption_link_count: 1 }
    });
    expect(eventLoopTicked).toBe(true);
    for (const name of contractNames) {
      await expect(readJson(join(extractionRoot, name))).resolves.toEqual(
        await readJson(join(fixtureRoot, `expected-${name}`))
      );
    }
  });

  it("fails closed inside the worker without exposing partial derived contracts", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "paper2md-bounded-contracts-"));
    const extractionRoot = join(packageRoot, "_extraction");
    await mkdir(extractionRoot);
    const article = Array.from({ length: 4097 }, (_, index) => `![${index}](images/${index}.png)`).join("\n");
    await Promise.all([
      writeFile(join(packageRoot, "article.md"), article, { encoding: "utf8", flag: "wx" }),
      writeFile(join(packageRoot, "mineru-result.json"), "[]\n", { encoding: "utf8", flag: "wx" }),
      writeFile(join(extractionRoot, "source.pdf"), "%PDF-1.4\n%%EOF\n", { encoding: "ascii", flag: "wx" })
    ]);
    let eventLoopTicked = false;
    const buildPromise = buildReaderContracts({ packageRoot, workerPath: contractWorkerPath, timeoutSeconds: 30 });
    setImmediate(() => { eventLoopTicked = true; });
    await expect(buildPromise).rejects.toThrow("image limit");
    expect(eventLoopTicked).toBe(true);
    for (const name of contractNames) expect(existsSync(join(extractionRoot, name))).toBe(false);
  });
});

describe.skipIf(!pythonAvailable)("Python reader-contract golden baseline", () => {
  it("keeps the current deterministic contract output frozen during the TypeScript migration", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "paper2md-contract-golden-"));
    const extractionRoot = join(packageRoot, "_extraction");
    await mkdir(extractionRoot);
    await Promise.all([
      copyFile(join(repositoryRoot, "test", "mineru-package", "paper.md"), join(packageRoot, "article.md")),
      copyFile(join(repositoryRoot, "test", "mineru-package", "paper_content_list.json"), join(packageRoot, "mineru-result.json")),
      writeFile(join(extractionRoot, "source.pdf"), "%PDF-1.4\n%%EOF\n", { encoding: "ascii", flag: "wx" })
    ]);

    await execFileAsync(python, [
      join(repositoryRoot, "apps", "processing-service", "scripts", "build_reader_contracts.py"),
      "--package-root",
      packageRoot
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    for (const name of contractNames) {
      await expect(readJson(join(extractionRoot, name))).resolves.toEqual(
        await readJson(join(repositoryRoot, "test", "fixtures", "reader-contract-golden", name))
      );
    }
  });
});
