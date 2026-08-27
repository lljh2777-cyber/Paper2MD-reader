import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { assertOpaqueId, type PublishedPackageDescriptor, type PublishedPackageFile } from "../../../packages/agent-contracts/src/index";
import { adaptClippingMarkdown } from "../../../src/model/clipping-markdown";
import { normalizePackagePath } from "./package-path";

const MAX_FILES = 1_024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 64 * 1024 * 1024;
const MAX_SECTION_BYTES = 256 * 1024;
const MAX_HEADINGS = 512;
const MAX_FIGURES = 512;
const SHA256 = /^[0-9a-f]{64}$/;

export type PublishedPackageKind = "mineru" | "clipping";

interface PackageRecord {
  root: string;
  kind: PublishedPackageKind;
  descriptor: PublishedPackageDescriptor;
  manifestPath: string;
  validationPath: string;
  manifest: Record<string, unknown>;
  validation: Record<string, unknown>;
  createdAt?: string;
  integrity: "hash-bound" | "legacy-size-bound";
}

interface MarkdownHeading {
  heading_id: string;
  level: number;
  label: string;
  line: number;
  end_line: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function printableLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label.slice(0, 512) || fallback;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readTextWithin(path: string, maximumBytes: number, label: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error(`${label} is missing, unsafe, empty, or too large`);
  }
  return readFile(path, "utf8");
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readTextWithin(path, MAX_JSON_BYTES, label)) as unknown;
  const parsed = object(value);
  if (!parsed) throw new Error(`${label} must contain a JSON object`);
  return parsed;
}

async function walkPackage(
  root: string,
  directory = root,
  depth = 0,
  state: { count: number; totalBytes: number } = { count: 0, totalBytes: 0 }
): Promise<PublishedPackageFile[]> {
  if (depth > 16) throw new Error("Published package exceeds the directory-depth limit");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: PublishedPackageFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in published packages");
    if (entry.isDirectory()) files.push(...await walkPackage(root, path, depth + 1, state));
    else if (entry.isFile()) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.size < 1 || info.size > MAX_FILE_BYTES) {
        throw new Error(`Published package contains an invalid file: ${entry.name}`);
      }
      const relativePath = relative(root, path).split(sep).join("/");
      if (normalizePackagePath(relativePath) !== relativePath) throw new Error("Published package contains an unsafe file path");
      state.count += 1;
      state.totalBytes += info.size;
      if (state.count > MAX_FILES) throw new Error(`Published package exceeds ${MAX_FILES} files`);
      if (state.totalBytes > MAX_TOTAL_BYTES) throw new Error("Published package exceeds the aggregate size limit");
      files.push({
        path: relativePath,
        size: info.size,
        sha256: await sha256(path)
      });
    }
  }
  return files;
}

function assertExactFiles(files: readonly PublishedPackageFile[], expected: ReadonlySet<string>): void {
  const actual = new Set(files.map((file) => file.path));
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
    throw new Error("Published package file inventory does not match its immutable manifest");
  }
}

function fileMap(files: readonly PublishedPackageFile[]): Map<string, PublishedPackageFile> {
  return new Map(files.map((file) => [file.path, file]));
}

function assertedManifestFile(
  entry: Record<string, unknown> | undefined,
  files: ReadonlyMap<string, PublishedPackageFile>,
  sizeKey: "size" | "size_bytes",
  label: string
): string {
  if (!entry || typeof entry.path !== "string") throw new Error(`${label} has an invalid path`);
  const path = normalizePackagePath(entry.path);
  const file = files.get(path);
  if (!file || entry[sizeKey] !== file.size || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) || entry.sha256 !== file.sha256) {
    throw new Error(`${label} does not match ${path}`);
  }
  return path;
}

function validateMineru(
  packageId: string,
  root: string,
  files: readonly PublishedPackageFile[],
  manifest: Record<string, unknown>,
  validation: Record<string, unknown>
): PackageRecord {
  if (manifest.schema_version !== 1 || manifest.extractor !== "mineru-open-api" || validation.status !== "passed") {
    throw new Error("MinerU package has unsupported or incomplete validation metadata");
  }
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : undefined;
  if (!outputs || !outputs.length || outputs.length > MAX_FILES) throw new Error("MinerU manifest has an invalid output index");
  const byPath = fileMap(files);
  const expected = new Set<string>(["_extraction/manifest.json", "_extraction/validation.json"]);
  for (const item of outputs) {
    const path = assertedManifestFile(object(item), byPath, "size", "MinerU output");
    if (expected.has(path)) throw new Error("MinerU manifest contains a duplicate output path");
    expected.add(path);
  }
  if (!expected.has("article.md")) throw new Error("MinerU manifest is not bound to article.md");
  const source = object(manifest.source);
  const sourceFile = byPath.get("_extraction/source.pdf");
  if (!sourceFile || source?.size !== sourceFile.size || source?.sha256 !== sourceFile.sha256) {
    throw new Error("MinerU manifest does not bind the immutable source PDF");
  }
  assertExactFiles(files, expected);
  const fallback = basename(packageId);
  const filename = printableLabel(source?.original_name, fallback);
  return {
    root,
    kind: "mineru",
    descriptor: {
      packageId,
      label: filename.replace(/\.pdf$/i, "") || fallback,
      files: [...files]
    },
    manifestPath: "_extraction/manifest.json",
    validationPath: "_extraction/validation.json",
    manifest,
    validation,
    createdAt: timestamp(manifest.created_at),
    integrity: "hash-bound"
  };
}

function validateClipping(
  packageId: string,
  root: string,
  files: readonly PublishedPackageFile[],
  manifest: Record<string, unknown>,
  validation: Record<string, unknown>
): PackageRecord {
  if (manifest.schema_version !== "paper2md-web-clipping-v1" || validation.status !== "passed") {
    throw new Error("Clipping package has unsupported or incomplete validation metadata");
  }
  const byPath = fileMap(files);
  const expected = new Set<string>([
    "_clipping/manifest.json",
    "_clipping/validation.json",
    "_clipping/source.html"
  ]);
  const articlePath = assertedManifestFile(object(manifest.article), byPath, "size_bytes", "Clipping article");
  if (articlePath !== "article.md") throw new Error("Clipping manifest does not select article.md");
  expected.add(articlePath);
  const images = Array.isArray(manifest.images) ? manifest.images : undefined;
  if (!images || images.length > MAX_FIGURES) throw new Error("Clipping manifest has an invalid image index");
  let hashBound = true;
  for (const item of images) {
    const entry = object(item);
    if (!entry || typeof entry.path !== "string") throw new Error("Clipping manifest contains an invalid image entry");
    const path = normalizePackagePath(entry.path);
    if (!/^images\/figure-\d{4}\.(?:bmp|gif|jpe?g|png|webp)$/i.test(path) || expected.has(path)) {
      throw new Error("Clipping manifest contains an unsafe or duplicate image path");
    }
    const file = byPath.get(path);
    if (!file || entry.size_bytes !== file.size) throw new Error(`Clipping image does not match ${path}`);
    if (entry.sha256 === undefined) {
      hashBound = false;
    } else if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) || entry.sha256 !== file.sha256) {
      throw new Error(`Clipping image hash does not match ${path}`);
    }
    expected.add(path);
  }
  const validationSource = object(validation.source);
  if (!validationSource) throw new Error("Clipping validation does not bind the immutable source snapshot");
  const sourcePath = assertedManifestFile(validationSource, byPath, "size_bytes", "Clipping source snapshot");
  if (sourcePath !== "_clipping/source.html") throw new Error("Clipping validation does not bind the immutable source snapshot");
  assertExactFiles(files, expected);
  const source = object(manifest.source);
  const extraction = object(manifest.extraction);
  return {
    root,
    kind: "clipping",
    descriptor: {
      packageId,
      label: printableLabel(source?.title, packageId),
      files: [...files]
    },
    manifestPath: "_clipping/manifest.json",
    validationPath: "_clipping/validation.json",
    manifest,
    validation,
    createdAt: timestamp(extraction?.created_at),
    integrity: hashBound ? "hash-bound" : "legacy-size-bound"
  };
}

function markdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split(/\r?\n/);
  const raw: Array<Omit<MarkdownHeading, "heading_id" | "end_line">> = [];
  let fence: { marker: string; length: number } | undefined;
  let frontmatter = lines[0]?.trim() === "---";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0]!;
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/.exec(line);
    if (atx) {
      const label = atx[2].replace(/<[^>]*>/g, "").replace(/[*_`~\[\]]/g, "").replace(/\s+/g, " ").trim();
      if (label && raw.length <= MAX_HEADINGS) raw.push({ level: atx[1].length, label: label.slice(0, 512), line: index + 1 });
      continue;
    }
    if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      const previous = lines[index - 1]?.trim() ?? "";
      if (previous && !/^(?:[-*_]>?|\d+[.)])\s/.test(previous)) {
        if (raw.length <= MAX_HEADINGS) {
          raw.push({ level: line.includes("=") ? 1 : 2, label: previous.replace(/<[^>]*>/g, "").slice(0, 512), line: index });
        }
      }
    }
  }
  return raw.slice(0, MAX_HEADINGS + 1).map((heading, index, headings) => {
    let endLine = lines.length;
    for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
      if (headings[cursor]!.level <= heading.level) {
        endLine = headings[cursor]!.line - 1;
        break;
      }
    }
    return { ...heading, heading_id: `heading-${String(index + 1).padStart(4, "0")}`, end_line: endLine };
  });
}

function boundedLines(lines: readonly string[], startLine: number, endLine: number, maximumLines: number) {
  const selected: string[] = [];
  let bytes = 0;
  let cursor = startLine;
  let truncatedLine = false;
  while (cursor <= endLine && selected.length < maximumLines) {
    const line = lines[cursor - 1] ?? "";
    const lineBytes = Buffer.byteLength(line) + (selected.length ? 1 : 0);
    if (bytes + lineBytes > MAX_SECTION_BYTES) {
      if (!selected.length) {
        selected.push(Buffer.from(line).subarray(0, MAX_SECTION_BYTES).toString("utf8"));
        cursor += 1;
        truncatedLine = true;
      }
      break;
    }
    selected.push(line);
    bytes += lineBytes;
    cursor += 1;
  }
  return {
    content: selected.join("\n"),
    endLine: Math.max(startLine - 1, cursor - 1),
    truncated: cursor <= endLine,
    truncatedLine
  };
}

function firstSourceLocation(value: unknown): { page_index?: number; bbox?: unknown } {
  if (!Array.isArray(value)) return {};
  const span = object(value[0]);
  return span && Number.isSafeInteger(span.page_index)
    ? { page_index: Number(span.page_index), bbox: object(span.bbox) }
    : {};
}

export class PublishedPackageCatalog {
  private readonly cache = new Map<string, PackageRecord>();

  constructor(private readonly dataRoot: string, private readonly readerBaseUrl: string) {}

  private rootsFor(packageId: string): string[] {
    const id = assertOpaqueId(packageId, "package_id");
    return [join(this.dataRoot, "packages", id), join(this.dataRoot, "jobs", id, "package")];
  }

  private async inspectRoot(packageId: string, root: string): Promise<PackageRecord | undefined> {
    const info = await lstat(root).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return undefined;
    const files = await walkPackage(root);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!files.length || total > MAX_TOTAL_BYTES) throw new Error("Published package is empty or exceeds the aggregate size limit");
    const paths = new Set(files.map((file) => file.path));
    const clipping = paths.has("_clipping/manifest.json") || paths.has("_clipping/validation.json");
    const mineru = paths.has("_extraction/manifest.json") || paths.has("_extraction/validation.json");
    if (clipping === mineru) throw new Error("Published package type is missing or ambiguous");
    const manifestPath = clipping ? "_clipping/manifest.json" : "_extraction/manifest.json";
    const validationPath = clipping ? "_clipping/validation.json" : "_extraction/validation.json";
    const [manifest, validation] = await Promise.all([
      readJsonObject(join(root, ...manifestPath.split("/")), "Package manifest"),
      readJsonObject(join(root, ...validationPath.split("/")), "Package validation")
    ]);
    return clipping
      ? validateClipping(packageId, root, files, manifest, validation)
      : validateMineru(packageId, root, files, manifest, validation);
  }

  private async packageIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const parent of [join(this.dataRoot, "packages"), join(this.dataRoot, "jobs")]) {
      const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          ids.add(assertOpaqueId(entry.name, "package_id"));
        } catch {
          // Ignore storage entries that cannot be addressed through the public opaque-ID boundary.
        }
      }
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
  }

  async get(packageId: string): Promise<PackageRecord | undefined> {
    const records = (await Promise.all(this.rootsFor(packageId).map((root) => this.inspectRoot(packageId, root)))).filter(Boolean) as PackageRecord[];
    if (records.length > 1) throw new Error("Package ID resolves to more than one published package");
    const record = records[0];
    if (record) this.cache.set(packageId, record);
    else this.cache.delete(packageId);
    return record;
  }

  async descriptor(packageId: string): Promise<PublishedPackageDescriptor | undefined> {
    const record = await this.get(packageId);
    return record ? structuredClone(record.descriptor) : undefined;
  }

  async packageFilePath(packageId: string, relativePath: string): Promise<string | undefined> {
    const path = normalizePackagePath(relativePath);
    assertOpaqueId(packageId, "package_id");
    const record = this.cache.get(packageId) ?? await this.get(packageId);
    if (!record) return undefined;
    const expected = record.descriptor.files.find((file) => file.path === path);
    if (!expected) return undefined;
    const target = join(record.root, ...path.split("/"));
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== expected.size || await sha256(target) !== expected.sha256) {
      throw new Error("Package file changed after catalog validation");
    }
    return target;
  }

  async list(cursor?: string, limit = 25): Promise<Record<string, unknown>> {
    const ids = (await this.packageIds()).filter((id) => !cursor || id.localeCompare(cursor) > 0);
    const packages: Record<string, unknown>[] = [];
    let consumed = 0;
    for (const id of ids) {
      consumed += 1;
      try {
        const record = await this.get(id);
        if (!record) continue;
        packages.push({
          package_id: id,
          label: record.descriptor.label,
          kind: record.kind,
          created_at: record.createdAt ?? null,
          integrity: record.integrity,
          file_count: record.descriptor.files.length,
          total_size_bytes: record.descriptor.files.reduce((sum, file) => sum + file.size, 0),
          reader_url: new URL(`/reader/${encodeURIComponent(id)}`, this.readerBaseUrl).href
        });
        if (packages.length >= limit) break;
      } catch {
        // Incomplete, mutated, ambiguous, and unsupported packages fail closed and are not advertised.
      }
    }
    const last = packages.at(-1)?.package_id;
    const more = consumed < ids.length;
    return { packages, next_cursor: more && typeof last === "string" ? last : null };
  }

  async readManifest(packageId: string): Promise<Record<string, unknown>> {
    const record = await this.get(packageId);
    if (!record) throw new Error("Package not found");
    return {
      package_id: packageId,
      label: record.descriptor.label,
      kind: record.kind,
      integrity: record.integrity,
      manifest_path: record.manifestPath,
      manifest: structuredClone(record.manifest),
      validation_path: record.validationPath,
      validation: structuredClone(record.validation)
    };
  }

  async readArticleSection(input: { package_id: string; heading_id?: string; start_line?: number; max_lines?: number }): Promise<Record<string, unknown>> {
    const record = await this.get(input.package_id);
    if (!record) throw new Error("Package not found");
    const article = await readTextWithin(join(record.root, "article.md"), MAX_ARTICLE_BYTES, "article.md");
    const lines = article.split(/\r?\n/);
    const allHeadings = markdownHeadings(article);
    const heading = input.heading_id ? allHeadings.find((item) => item.heading_id === input.heading_id) : undefined;
    if (input.heading_id && !heading) throw new Error("Article heading not found");
    const sectionStart = heading?.line ?? 1;
    const sectionEnd = heading?.end_line ?? lines.length;
    const startLine = input.start_line ?? sectionStart;
    if (startLine < sectionStart || startLine > sectionEnd) throw new Error("start_line is outside the selected article section");
    const selected = boundedLines(lines, startLine, sectionEnd, input.max_lines ?? 120);
    return {
      package_id: input.package_id,
      heading_id: heading?.heading_id ?? null,
      start_line: startLine,
      end_line: selected.endLine,
      section_end_line: sectionEnd,
      total_lines: lines.length,
      content: selected.content,
      truncated: selected.truncated,
      truncated_line: selected.truncatedLine,
      next_start_line: selected.truncated ? selected.endLine + 1 : null,
      headings: allHeadings.slice(0, MAX_HEADINGS),
      headings_truncated: allHeadings.length > MAX_HEADINGS
    };
  }

  async listFigures(packageId: string): Promise<Record<string, unknown>> {
    const record = await this.get(packageId);
    if (!record) throw new Error("Package not found");
    const article = await readTextWithin(join(record.root, "article.md"), MAX_ARTICLE_BYTES, "article.md");
    if (record.kind === "clipping") {
      const visuals = adaptClippingMarkdown(article).visuals.filter((visual) => visual.kind === "figure");
      const figures = visuals.slice(0, MAX_FIGURES).map((visual) => ({
        figure_id: visual.id,
        path: visual.path,
        label: visual.label,
        caption_text: visual.captionText ?? null,
        placement_block_id: visual.placementBlockId,
        caption_block_id: visual.captionBlockId ?? null
      }));
      return { package_id: packageId, figures, count: figures.length, truncated: visuals.length > figures.length };
    }

    const readerPath = join(record.root, "_paper2md", "reader.json");
    const reader = await readJsonObject(readerPath, "Reader contract");
    const assets = Array.isArray(reader.assets) ? reader.assets : [];
    const figures = assets.flatMap((value) => {
      const asset = object(value);
      if (!asset || asset.kind !== "figure" || typeof asset.id !== "string" || typeof asset.path !== "string") return [];
      const path = normalizePackagePath(asset.path);
      if (!record.descriptor.files.some((file) => file.path === path)) throw new Error("Reader figure points outside the verified package inventory");
      return [{
        figure_id: asset.id,
        path,
        label: printableLabel(asset.display_label, basename(path).replace(/\.[^.]+$/, "")),
        caption_block_id: typeof asset.caption_block_id === "string" ? asset.caption_block_id : null,
        placement_block_id: typeof asset.placement_block_id === "string" ? asset.placement_block_id : null,
        ...firstSourceLocation(asset.source_spans)
      }];
    });
    const bounded = figures.slice(0, MAX_FIGURES);
    return { package_id: packageId, figures: bounded, count: bounded.length, truncated: figures.length > bounded.length };
  }
}
