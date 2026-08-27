import {
  CLIPPING_SUBMISSION_SCHEMA_VERSION,
  MAX_CLIPPED_SOURCE_BYTES,
  type ClippingExtractionMetadata,
  type ClippingSubmissionMetadata,
  type ExtractedPaperPage,
  type LocalizedImage
} from "../../../packages/clipper-core/src/index";

export const DEFAULT_PROCESSING_SERVICE_ORIGIN = "http://127.0.0.1:8787";
const PUBLISH_PATH = "/api/v1/clippings";
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface PublishedClipping {
  packageId: string;
  readerUrl: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function processingServicePermissionPattern(serviceOrigin: string): string {
  const url = new URL(serviceOrigin);
  if (url.origin !== DEFAULT_PROCESSING_SERVICE_ORIGIN || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Clipper processing service must use the fixed loopback origin.");
  }
  return `${url.protocol}//${url.hostname}/*`;
}

export function buildClippingSubmissionFormData(input: {
  page: ExtractedPaperPage;
  sourceHtml: string;
  localizedImages: ReadonlyMap<string, LocalizedImage>;
  createdAt: string;
  extraction: ClippingExtractionMetadata;
}): FormData {
  if (new TextEncoder().encode(input.sourceHtml).byteLength > MAX_CLIPPED_SOURCE_BYTES) {
    throw new Error("Clipped source HTML exceeds the safe size limit.");
  }
  const images = [...input.localizedImages.values()];
  const metadata: ClippingSubmissionMetadata = {
    schemaVersion: CLIPPING_SUBMISSION_SCHEMA_VERSION,
    createdAt: input.createdAt,
    page: {
      title: input.page.title,
      author: input.page.author,
      published: input.page.published,
      description: input.page.description,
      sourceUrl: input.page.sourceUrl,
      language: input.page.language,
      wordCount: input.page.wordCount
    },
    extraction: input.extraction,
    images: images.map((image, index) => ({
      field: `image-${String(index + 1).padStart(4, "0")}`,
      path: image.path,
      sourceUrl: image.url,
      mime: image.mime
    }))
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("markdown", new Blob([input.page.markdown], { type: "text/markdown;charset=utf-8" }), "article-source.md");
  form.set("source_html", new Blob([input.sourceHtml], { type: "text/html;charset=utf-8" }), "source.html");
  images.forEach((image, index) => {
    const field = metadata.images[index]!.field;
    const body = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer;
    form.set(field, new Blob([body], { type: image.mime }), image.path.split("/").at(-1) ?? field);
  });
  return form;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Processing service response exceeds the safe size limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Processing service response has no body.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("Response exceeds the safe size limit.");
        throw new Error("Processing service response exceeds the safe size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function validatedResult(value: unknown): PublishedClipping {
  const payload = object(value);
  const packageId = typeof payload?.package_id === "string" ? payload.package_id : "";
  const readerUrl = typeof payload?.reader_url === "string" ? payload.reader_url : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(packageId)) {
    throw new Error("Processing service returned an invalid package ID.");
  }
  const url = new URL(readerUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.pathname !== `/reader/${encodeURIComponent(packageId)}`) {
    throw new Error("Processing service returned an unsafe Reader URL.");
  }
  return { packageId, readerUrl: url.href };
}

export async function requestProcessingServicePermission(serviceOrigin = DEFAULT_PROCESSING_SERVICE_ORIGIN): Promise<boolean> {
  return chrome.permissions.request({ origins: [processingServicePermissionPattern(serviceOrigin)] });
}

export async function publishClippingSubmission(
  form: FormData,
  options: { serviceOrigin?: string; fetch?: typeof fetch } = {}
): Promise<PublishedClipping> {
  const serviceOrigin = options.serviceOrigin ?? DEFAULT_PROCESSING_SERVICE_ORIGIN;
  const permission = processingServicePermissionPattern(serviceOrigin);
  if (typeof chrome !== "undefined" && chrome.permissions && !await chrome.permissions.contains({ origins: [permission] })) {
    throw new Error("尚未授权访问本地 Paper2MD processing service。");
  }
  const response = await (options.fetch ?? fetch)(new URL(PUBLISH_PATH, serviceOrigin), {
    method: "POST",
    body: form,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" }
  });
  const payload = await boundedJson(response);
  if (!response.ok) {
    const root = object(payload);
    const problem = object(root?.error);
    const message = typeof problem?.message === "string"
      ? problem.message
      : typeof root?.error === "string" ? root.error : `Processing service returned HTTP ${response.status}.`;
    throw new Error(message.slice(0, 1_024));
  }
  return validatedResult(payload);
}
