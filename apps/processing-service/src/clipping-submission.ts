import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CLIPPING_SUBMISSION_SCHEMA_VERSION,
  MAX_CLIPPED_ARTICLE_BYTES,
  MAX_CLIPPED_IMAGE_BYTES,
  MAX_CLIPPED_IMAGES,
  MAX_CLIPPED_SOURCE_BYTES,
  MAX_CLIPPED_TOTAL_IMAGE_BYTES,
  buildClippingPackageFiles,
  extensionForMime,
  isFetchableImageUrl,
  type ClippingSubmissionMetadata,
  type ExtractedPaperPage,
  type LocalizedImage
} from "../../../packages/clipper-core/src/index";
import type { PublishedPackageDescriptor } from "./contracts";
import type { ProcessingServiceConfig } from "./config";
import { publishClippingPackage } from "./clipping-package-publisher";

const MAX_METADATA_BYTES = 256 * 1024;
const IMAGE_FIELD = /^image-(\d{4})$/;

export interface ClippingPublishResult {
  package_id: string;
  reader_url: string;
  package: PublishedPackageDescriptor;
}

export interface PublishClippingSubmissionOptions {
  publish?: typeof publishClippingPackage;
  prepareStorage?: (submissionRoot: string, packagesRoot: string) => Promise<void>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function text(value: unknown, label: string, maximum: number, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseSourceUrl(value: unknown): string {
  const source = text(value, "page.sourceUrl", 8_192, false);
  const url = new URL(source);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("page.sourceUrl is invalid");
  return url.href;
}

function parseMetadata(value: string): ClippingSubmissionMetadata {
  if (new TextEncoder().encode(value).byteLength > MAX_METADATA_BYTES) throw new Error("Clipping metadata is too large");
  const root = object(JSON.parse(value));
  if (!root) throw new Error("Clipping metadata must be an object");
  exactKeys(root, ["schemaVersion", "createdAt", "page", "extraction", "images"], "Clipping metadata");
  if (root.schemaVersion !== CLIPPING_SUBMISSION_SCHEMA_VERSION) throw new Error("Unsupported clipping submission schema");
  const createdAt = text(root.createdAt, "createdAt", 64, false);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new Error("createdAt is invalid");

  const page = object(root.page);
  if (!page) throw new Error("page must be an object");
  exactKeys(page, ["title", "author", "published", "description", "sourceUrl", "language", "wordCount"], "page");
  if (!Number.isSafeInteger(page.wordCount) || Number(page.wordCount) < 0 || Number(page.wordCount) > 100_000_000) {
    throw new Error("page.wordCount is invalid");
  }

  const extraction = object(root.extraction);
  if (!extraction) throw new Error("extraction must be an object");
  exactKeys(extraction, ["engine", "engineVersion", "useAsyncFallback"], "extraction");
  if (extraction.engine !== "defuddle" || extraction.engineVersion !== "0.19.3" || extraction.useAsyncFallback !== false) {
    throw new Error("Unsupported clipping extraction contract");
  }

  if (!Array.isArray(root.images) || root.images.length > MAX_CLIPPED_IMAGES) throw new Error("images index is invalid");
  const imageFields = new Set<string>();
  const imagePaths = new Set<string>();
  const imageUrls = new Set<string>();
  const images = root.images.map((item, index) => {
    const image = object(item);
    if (!image) throw new Error("images index contains a non-object entry");
    exactKeys(image, ["field", "path", "sourceUrl", "mime"], "image entry");
    const field = text(image.field, "image.field", 32, false);
    const path = text(image.path, "image.path", 128, false);
    const sourceUrl = text(image.sourceUrl, "image.sourceUrl", 8_192, false);
    const mime = text(image.mime, "image.mime", 64, false).toLowerCase();
    const match = IMAGE_FIELD.exec(field);
    const expectedExtension = extensionForMime(mime);
    let parsedSource: URL;
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      throw new Error("image.sourceUrl is invalid");
    }
    if (!match || Number(match[1]) !== index + 1 || imageFields.has(field)) throw new Error("image.field is invalid or duplicate");
    if (!/^images\/figure-\d{4}\.(?:bmp|gif|jpe?g|png|webp)$/i.test(path) || imagePaths.has(path)) {
      throw new Error("image.path is unsafe or duplicate");
    }
    if (!expectedExtension || !path.toLowerCase().endsWith(`.${expectedExtension}`)) throw new Error("image MIME does not match its path");
    if (!isFetchableImageUrl(parsedSource) || imageUrls.has(parsedSource.href)) {
      throw new Error("image.sourceUrl is not permitted or is duplicated");
    }
    imageFields.add(field);
    imagePaths.add(path);
    imageUrls.add(parsedSource.href);
    return { field, path, sourceUrl: parsedSource.href, mime };
  });

  return {
    schemaVersion: CLIPPING_SUBMISSION_SCHEMA_VERSION,
    createdAt,
    page: {
      title: text(page.title, "page.title", 2_048, false),
      author: text(page.author, "page.author", 8_192),
      published: text(page.published, "page.published", 256),
      description: text(page.description, "page.description", 32_768),
      sourceUrl: parseSourceUrl(page.sourceUrl),
      language: text(page.language, "page.language", 128),
      wordCount: Number(page.wordCount)
    },
    extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false },
    images
  };
}

function singleFile(form: FormData, field: string): File {
  const values = form.getAll(field);
  if (values.length !== 1 || typeof values[0] === "string") throw new Error(`${field} must be one file part`);
  return values[0];
}

async function bytesWithin(file: File, maximum: number, label: string): Promise<Uint8Array> {
  if (file.size < 1 || file.size > maximum) throw new Error(`${label} exceeds its safe size limit`);
  return new Uint8Array(await file.arrayBuffer());
}

export async function parseClippingSubmission(form: FormData): Promise<{
  metadata: ClippingSubmissionMetadata;
  page: ExtractedPaperPage;
  sourceHtml: Uint8Array;
  localizedImages: Map<string, LocalizedImage>;
}> {
  const metadataValues = form.getAll("metadata");
  if (metadataValues.length !== 1 || typeof metadataValues[0] !== "string") throw new Error("metadata must be one text field");
  const metadata = parseMetadata(metadataValues[0]);
  const expectedFields = new Set(["metadata", "markdown", "source_html", ...metadata.images.map((image) => image.field)]);
  const counts = new Map<string, number>();
  for (const [field] of form.entries()) counts.set(field, (counts.get(field) ?? 0) + 1);
  if (counts.size !== expectedFields.size || [...counts].some(([field, count]) => !expectedFields.has(field) || count !== 1)) {
    throw new Error("Clipping submission contains missing, duplicate, or unsupported parts");
  }

  const markdownBytes = await bytesWithin(singleFile(form, "markdown"), MAX_CLIPPED_ARTICLE_BYTES, "markdown");
  const sourceHtml = await bytesWithin(singleFile(form, "source_html"), MAX_CLIPPED_SOURCE_BYTES, "source_html");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(markdownBytes);
  const html = new TextDecoder("utf-8", { fatal: true }).decode(sourceHtml);
  if (markdown.trim().length < 200) throw new Error("Extracted Markdown is implausibly short");
  if (!/<html(?:\s|>)/i.test(html)) throw new Error("Source snapshot is not an HTML document");

  const localizedImages = new Map<string, LocalizedImage>();
  let totalImageBytes = 0;
  for (const image of metadata.images) {
    const file = singleFile(form, image.field);
    if (file.type.toLowerCase() !== image.mime) throw new Error(`Image part MIME does not match ${image.field}`);
    const bytes = await bytesWithin(file, MAX_CLIPPED_IMAGE_BYTES, image.field);
    totalImageBytes += bytes.byteLength;
    if (totalImageBytes > MAX_CLIPPED_TOTAL_IMAGE_BYTES) throw new Error("Localized images exceed the aggregate safe limit");
    localizedImages.set(image.sourceUrl, { url: image.sourceUrl, path: image.path, mime: image.mime, bytes });
  }

  return { metadata, page: { ...metadata.page, markdown }, sourceHtml, localizedImages };
}

export async function publishClippingSubmission(
  form: FormData,
  config: ProcessingServiceConfig,
  options: PublishClippingSubmissionOptions = {}
): Promise<ClippingPublishResult> {
  const parsed = await parseClippingSubmission(form);
  const clipping = await buildClippingPackageFiles({
    page: parsed.page,
    localizedImages: parsed.localizedImages,
    createdAt: parsed.metadata.createdAt,
    extraction: parsed.metadata.extraction
  });
  const packageId = randomUUID();
  const submissionId = randomUUID();
  const submissionRoot = join(config.dataRoot, "clipping-submissions", submissionId);
  const packagesRoot = join(config.dataRoot, "packages");
  const prepareStorage = options.prepareStorage ?? (async () => {
    await mkdir(submissionRoot, { recursive: true });
    await mkdir(packagesRoot, { recursive: true });
  });
  await prepareStorage(submissionRoot, packagesRoot);
  const descriptor = await (options.publish ?? publishClippingPackage)({
    packageId,
    label: parsed.page.title,
    files: clipping.files,
    sourceHtml: parsed.sourceHtml,
    packageStage: join(submissionRoot, "package-stage"),
    publishedRoot: join(packagesRoot, packageId)
  });
  return {
    package_id: packageId,
    reader_url: new URL(`/reader/${encodeURIComponent(packageId)}`, config.readerBaseUrl).href,
    package: descriptor
  };
}
