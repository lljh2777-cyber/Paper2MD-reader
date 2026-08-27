import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { PublishedPackageDescriptor, PublishedPackageFile } from "./contracts";
import { normalizePackagePath } from "./package-path";

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(root: string, directory = root, depth = 0): Promise<string[]> {
  if (depth > 8) throw new Error("Clipping package exceeds the directory-depth limit");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in clipping packages");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path, depth + 1));
    else if (entry.isFile()) files.push(path);
    if (files.length > MAX_FILES) throw new Error(`Clipping package exceeds ${MAX_FILES} files`);
  }
  return files;
}

async function assertLimits(root: string): Promise<void> {
  let total = 0;
  for (const path of await walkFiles(root)) {
    const info = await stat(path);
    if (info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error(`Invalid clipping package file size: ${basename(path)}`);
    total += info.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("Clipping package exceeds the aggregate size limit");
  }
}

async function fileRecord(path: string, root: string): Promise<PublishedPackageFile> {
  const bytes = await readFile(path);
  return {
    path: relative(root, path).split(sep).join("/"),
    size: bytes.byteLength,
    sha256: sha256(bytes)
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function validateStage(root: string, sourceBytes: Uint8Array): Promise<Record<string, unknown>> {
  const [articleBytes, manifestBytes, packagedSourceBytes] = await Promise.all([
    readFile(join(root, "article.md")),
    readFile(join(root, "_clipping", "manifest.json")),
    readFile(join(root, "_clipping", "source.html"))
  ]);
  const article = articleBytes.toString("utf8");
  if (article.trim().length < 200 || !/^#\s+\S/m.test(article)) throw new Error("Clipped article is empty or implausibly short");
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  const articleEntry = object(manifest?.article);
  if (manifest?.schema_version !== "paper2md-web-clipping-v1"
    || articleEntry?.path !== "article.md"
    || articleEntry?.sha256 !== sha256(articleBytes)
    || articleEntry?.size_bytes !== articleBytes.byteLength) {
    throw new Error("Clipping manifest does not match article.md");
  }
  if (sha256(sourceBytes) !== sha256(packagedSourceBytes)) throw new Error("Packaged source HTML does not match the acquired source");
  if (/<img\b/i.test(article)) throw new Error("Clipping article contains an unlocalized HTML image");
  const manifestImages = Array.isArray(manifest.images) ? manifest.images : undefined;
  if (!manifestImages) throw new Error("Clipping manifest has no valid image index");
  const indexedAssets = new Set<string>();
  for (const item of manifestImages) {
    const entry = object(item);
    if (!entry || typeof entry.path !== "string" || typeof entry.mime !== "string" || !Number.isSafeInteger(entry.size_bytes)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error("Clipping manifest contains an invalid image entry");
    }
    const asset = normalizePackagePath(entry.path);
    if (!/^images\/figure-\d{4}\.(?:bmp|gif|jpe?g|png|webp)$/i.test(asset) || indexedAssets.has(asset)) {
      throw new Error("Clipping manifest contains an unsafe or duplicate image path");
    }
    const bytes = await readFile(join(root, ...asset.split("/"))).catch(() => undefined);
    if (!bytes || bytes.byteLength !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Clipping manifest image does not match: ${asset}`);
    }
    indexedAssets.add(asset);
  }
  const referencedAssets = new Set<string>();
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_RE.exec(article))) {
    const asset = normalizePackagePath(match[1] || match[2]);
    if (!/^images\/figure-\d{4}\.(?:bmp|gif|jpe?g|png|webp)$/i.test(asset)) {
      throw new Error(`Clipping article contains an unsupported image path: ${asset}`);
    }
    const info = await stat(join(root, ...asset.split("/"))).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error(`Missing clipping image: ${asset}`);
    referencedAssets.add(asset);
  }
  if (referencedAssets.size !== indexedAssets.size || [...referencedAssets].some((asset) => !indexedAssets.has(asset))) {
    throw new Error("Clipping manifest image index does not match article.md");
  }
  return {
    status: "passed",
    checks: {
      article_nonempty: true,
      title_heading_present: true,
      clipping_manifest_matches: true,
      markdown_assets_exist: true,
      immutable_source_preserved: true,
      no_ai_processing: true
    },
    source: { path: "_clipping/source.html", size_bytes: sourceBytes.byteLength, sha256: sha256(sourceBytes) },
    article: { path: "article.md", size_bytes: articleBytes.byteLength, sha256: sha256(articleBytes) }
  };
}

export async function publishClippingPackage(input: {
  packageId: string;
  label: string;
  files: ReadonlyMap<string, Uint8Array>;
  sourceHtml: Uint8Array;
  packageStage: string;
  publishedRoot: string;
  onValidated?: () => void;
}): Promise<PublishedPackageDescriptor> {
  if (await stat(input.publishedRoot).catch(() => undefined)) throw new Error("A complete package already exists for this package ID");
  await mkdir(input.packageStage, { recursive: false });
  await mkdir(join(input.packageStage, "_clipping"), { recursive: false });
  if ([...input.files].some(([path]) => path.startsWith("images/"))) {
    await mkdir(join(input.packageStage, "images"), { recursive: false });
  }
  for (const [rawPath, bytes] of input.files) {
    const path = normalizePackagePath(rawPath);
    if (path !== "article.md" && path !== "_clipping/manifest.json" && !/^images\/figure-\d{4}\.(?:bmp|gif|jpe?g|png|webp)$/i.test(path)) {
      throw new Error(`Unexpected clipping package path: ${path}`);
    }
    await writeFile(join(input.packageStage, ...path.split("/")), bytes, { flag: "wx" });
  }
  await writeFile(join(input.packageStage, "_clipping", "source.html"), input.sourceHtml, { flag: "wx" });
  await assertLimits(input.packageStage);
  const validation = await validateStage(input.packageStage, input.sourceHtml);
  await writeFile(
    join(input.packageStage, "_clipping", "validation.json"),
    `${JSON.stringify(validation, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  await assertLimits(input.packageStage);
  input.onValidated?.();
  await rename(input.packageStage, input.publishedRoot);
  const files = await Promise.all((await walkFiles(input.publishedRoot)).map((path) => fileRecord(path, input.publishedRoot)));
  files.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return { packageId: input.packageId, label: input.label, files };
}
