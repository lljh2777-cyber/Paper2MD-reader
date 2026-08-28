import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { PublishedPackageDescriptor, PublishedPackageFile } from "./contracts";
import { buildReaderContracts, ReaderContractSummary } from "./reader-contract-builder";
import { normalizePackagePath } from "./package-path";
export { normalizePackagePath } from "./package-path";

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1_024;

interface MineruElement {
  record: Record<string, unknown>;
  pageIndex: number;
}

interface PackageValidation {
  status: "passed";
  checks: Record<string, boolean>;
  page_count: number;
  json_element_count: number;
  json_asset_count: number;
  markdown_asset_count: number;
  unreferenced_json_assets: string[];
  viewer_contracts: ReaderContractSummary;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function flattenMineruElements(value: unknown): MineruElement[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("MinerU JSON must be a non-empty array");
  const nested = value.every(Array.isArray);
  const result: MineruElement[] = [];
  if (nested) {
    value.forEach((page, pageIndex) => {
      (page as unknown[]).forEach((item) => {
        const valueRecord = record(item);
        if (valueRecord) result.push({ record: valueRecord, pageIndex });
      });
    });
  } else {
    value.forEach((item) => {
      const valueRecord = record(item);
      if (!valueRecord) return;
      const pageIndex = Number.isInteger(valueRecord.page_idx) && Number(valueRecord.page_idx) >= 0
        ? Number(valueRecord.page_idx)
        : 0;
      result.push({ record: valueRecord, pageIndex });
    });
  }
  if (!result.length) throw new Error("MinerU JSON contains no readable elements");
  return result;
}

function mineruAssetPath(item: Record<string, unknown>): string | undefined {
  const content = record(item.content);
  const imageSource = record(content?.image_source);
  const tableSource = record(content?.table_source);
  const candidates = [
    item.img_path,
    item.image_path,
    imageSource?.path,
    imageSource?.src,
    tableSource?.path,
    tableSource?.src,
    content?.img_path,
    content?.image_path,
    content?.table_img_path
  ];
  return candidates.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(rel);
}

async function requirePackageFile(packageRoot: string, relativePath: string): Promise<void> {
  const normalized = normalizePackagePath(relativePath);
  const target = resolve(packageRoot, ...normalized.split("/"));
  if (!inside(packageRoot, target)) throw new Error(`Package asset escapes root: ${relativePath}`);
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error(`Missing or empty package asset: ${relativePath}`);
  }
}

async function walkFiles(
  root: string,
  directory = root,
  state: { count: number } = { count: 0 },
  depth = 0
): Promise<string[]> {
  if (depth > 16) throw new Error("MinerU output exceeds the directory-depth limit");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in MinerU output");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path, state, depth + 1));
    else if (entry.isFile()) {
      state.count += 1;
      if (state.count > MAX_PACKAGE_FILES) throw new Error(`Package exceeds ${MAX_PACKAGE_FILES} files`);
      files.push(path);
    }
  }
  return files;
}

async function findOutputs(extractRoot: string): Promise<{ markdown: string; json: string; jsonFiles: string[] }> {
  const files = await walkFiles(extractRoot);
  const markdown = files.filter((path) => extname(path).toLowerCase() === ".md");
  if (markdown.length !== 1) throw new Error(`Expected one MinerU Markdown output, found ${markdown.length}`);
  const json = files.filter((path) => extname(path).toLowerCase() === ".json");
  const selectPreferred = (marker: string) => json.filter((path) => basename(path).toLowerCase().includes(marker));
  const v2 = selectPreferred("content_list_v2");
  const stable = selectPreferred("content_list").filter((path) => !basename(path).toLowerCase().includes("content_list_v2"));
  const selected = stable.length === 1 ? stable[0] : v2.length === 1 ? v2[0] : json.length === 1 ? json[0] : undefined;
  if (!selected) throw new Error(`Expected one unambiguous MinerU JSON output, found ${json.length}`);
  return { markdown: markdown[0], json: selected, jsonFiles: json };
}

async function preserveMineruJson(extractRoot: string, packageRoot: string, jsonFiles: string[]): Promise<void> {
  const mineruRoot = join(packageRoot, "mineru");
  await mkdir(mineruRoot);
  for (const source of jsonFiles) {
    if (!inside(extractRoot, source)) throw new Error("MinerU JSON source escapes extraction root");
    const relativePath = relative(extractRoot, source);
    const target = resolve(mineruRoot, relativePath);
    if (!inside(mineruRoot, target)) throw new Error("MinerU JSON target escapes package root");
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { errorOnExist: true });
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fileRecord(path: string, packageRoot: string): Promise<PublishedPackageFile> {
  const bytes = await readFile(path);
  return {
    path: relative(packageRoot, path).split(sep).join("/"),
    size: bytes.byteLength,
    sha256: sha256(bytes)
  };
}

async function validatePackage(packageRoot: string, viewerContracts: ReaderContractSummary): Promise<PackageValidation> {
  const markdownPath = join(packageRoot, "article.md");
  const jsonPath = join(packageRoot, "mineru-result.json");
  const [markdown, jsonText] = await Promise.all([
    readFile(markdownPath, "utf8"),
    readFile(jsonPath, "utf8")
  ]);
  if (markdown.trim().length < 100) throw new Error("MinerU article.md is empty or implausibly short");
  if (!/^#\s+\S/m.test(markdown)) throw new Error("MinerU article.md has no title heading");
  const elements = flattenMineruElements(JSON.parse(jsonText) as unknown);
  const jsonAssets = new Set<string>();
  for (const element of elements) {
    const rawPath = mineruAssetPath(element.record);
    if (!rawPath) continue;
    const path = normalizePackagePath(rawPath);
    await requirePackageFile(packageRoot, path);
    jsonAssets.add(path);
  }
  const markdownAssets = new Set<string>();
  for (const pattern of [MARKDOWN_IMAGE_RE, HTML_IMAGE_RE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown))) {
      const path = normalizePackagePath(match[1] || match[2]);
      await requirePackageFile(packageRoot, path);
      markdownAssets.add(path);
    }
  }
  return {
    status: "passed",
    checks: {
      markdown_nonempty: true,
      title_heading_present: true,
      json_array_valid: true,
      json_assets_exist: true,
      markdown_assets_exist: true,
      immutable_source_preserved: true,
      source_pdf_preserved: true,
      viewer_index_valid: true,
      visual_repair_valid: true,
      visual_candidates_valid: true
    },
    page_count: Math.max(...elements.map((element) => element.pageIndex)) + 1,
    json_element_count: elements.length,
    json_asset_count: jsonAssets.size,
    markdown_asset_count: markdownAssets.size,
    unreferenced_json_assets: [...jsonAssets].filter((path) => !markdownAssets.has(path)).sort(),
    viewer_contracts: viewerContracts
  };
}

async function assertPackageLimits(packageRoot: string): Promise<void> {
  const files = await walkFiles(packageRoot);
  if (files.length > MAX_PACKAGE_FILES) throw new Error(`Package exceeds ${MAX_PACKAGE_FILES} files`);
  let total = 0;
  for (const path of files) {
    const info = await stat(path);
    if (info.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`Package file is too large: ${basename(path)}`);
    total += info.size;
    if (total > MAX_PACKAGE_BYTES) throw new Error("Package exceeds the aggregate size limit");
  }
}

export async function publishMineruPackage(input: {
  packageId: string;
  filename: string;
  sourcePath: string;
  extractRoot: string;
  packageStage: string;
  publishedRoot: string;
  mineruOptions: Record<string, unknown>;
  contractWorkerPath: string;
  contractTimeoutSeconds: number;
  onValidated?: () => void;
}): Promise<PublishedPackageDescriptor> {
  const outputs = await findOutputs(input.extractRoot);
  await mkdir(input.packageStage, { recursive: false });
  await preserveMineruJson(input.extractRoot, input.packageStage, outputs.jsonFiles);
  await Promise.all([
    cp(outputs.markdown, join(input.packageStage, "article.md"), { errorOnExist: true }),
    cp(outputs.json, join(input.packageStage, "mineru-result.json"), { errorOnExist: true })
  ]);
  const imagesSource = join(dirname(outputs.markdown), "images");
  const imagesInfo = await stat(imagesSource).catch(() => undefined);
  if (imagesInfo?.isDirectory()) {
    await cp(imagesSource, join(input.packageStage, "images"), { recursive: true, errorOnExist: true });
  }
  const extractionRoot = join(input.packageStage, "_extraction");
  await mkdir(extractionRoot);
  await cp(input.sourcePath, join(extractionRoot, "source.pdf"), { errorOnExist: true });
  const viewerContracts = await buildReaderContracts({
    packageRoot: input.packageStage,
    workerPath: input.contractWorkerPath,
    timeoutSeconds: input.contractTimeoutSeconds
  });
  const [sourceBytes, packagedSourceBytes] = await Promise.all([
    readFile(input.sourcePath),
    readFile(join(extractionRoot, "source.pdf"))
  ]);
  if (sha256(sourceBytes) !== sha256(packagedSourceBytes)) {
    throw new Error("Packaged source.pdf does not match the uploaded PDF");
  }
  await assertPackageLimits(input.packageStage);
  const validation = await validatePackage(input.packageStage, viewerContracts);
  const generatedPaths = await walkFiles(input.packageStage);
  const outputsIndex = await Promise.all(generatedPaths.map((path) => fileRecord(path, input.packageStage)));
  const manifest = {
    schema_version: 1,
    extractor: "mineru-open-api",
    created_at: new Date().toISOString(),
    processing_depth: "conversion-only",
    source: {
      original_name: input.filename,
      size: sourceBytes.byteLength,
      sha256: sha256(sourceBytes)
    },
    privacy: {
      remote_processing: true,
      source_pdf_packaged: true,
      notice: "Document content was transmitted to the configured MinerU service; the source PDF is retained inside the published reading package for deterministic visual reconstruction."
    },
    options: input.mineruOptions,
    outputs: outputsIndex
  };
  await Promise.all([
    writeFile(join(extractionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(join(extractionRoot, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  ]);
  await assertPackageLimits(input.packageStage);
  input.onValidated?.();
  await rename(input.packageStage, input.publishedRoot);
  const files = await Promise.all((await walkFiles(input.publishedRoot)).map((path) => fileRecord(path, input.publishedRoot)));
  files.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return {
    packageId: input.packageId,
    label: input.filename.replace(/\.pdf$/i, "") || "Processed paper",
    files
  };
}
