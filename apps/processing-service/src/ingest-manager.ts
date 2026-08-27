import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Defuddle } from "defuddle/node";
import {
  MAX_CLIPPED_IMAGES,
  MAX_CLIPPED_IMAGE_BYTES,
  MAX_CLIPPED_TOTAL_IMAGE_BYTES,
  buildClippingPackageFiles,
  collectMarkdownImages,
  extensionForMime,
  isFetchableImageUrl,
  readResponseBytesWithinLimit,
  type ExtractedPaperPage,
  type LocalizedImage
} from "../../../packages/clipper-core/src/index";
import {
  assertIngestStateTransition,
  parsePaperQuery,
  type AttemptedSource,
  type FullTextSource,
  type IngestErrorCode,
  type IngestJob,
  type IngestProblem,
  type PaperResolution,
  type PublishedPackageDescriptor
} from "../../../packages/agent-contracts/src/index";
import type { ProcessingServiceConfig } from "./config";
import { publishClippingPackage } from "./clipping-package-publisher";

const MAX_FULL_TEXT_BYTES = 16 * 1024 * 1024;
const ALLOWED_FULL_TEXT_HOST = "pmc.ncbi.nlm.nih.gov";

interface InternalIngestJob {
  task: IngestJob;
  package?: PublishedPackageDescriptor;
  publishedRoot?: string;
  attemptedSources: AttemptedSource[];
}

export interface PaperResolverLike {
  resolve(input: string): Promise<PaperResolution>;
}

export interface IngestManagerOptions {
  fetch?: typeof fetch;
  publish?: typeof publishClippingPackage;
  prepareStorage?: (jobRoot: string, packagesRoot: string) => Promise<void>;
}

function publicTask(job: InternalIngestJob): IngestJob {
  return structuredClone(job.task);
}

function publicPackage(job: InternalIngestJob): PublishedPackageDescriptor | undefined {
  return job.package ? structuredClone(job.package) : undefined;
}

function boundedProblem(code: IngestErrorCode, message: string, attempts: readonly AttemptedSource[], nextSteps: string[]): IngestProblem {
  return {
    code,
    message: message.slice(0, 1_024),
    attempted_sources: structuredClone(attempts.slice(-32)),
    next_steps: nextSteps.slice(0, 8)
  };
}

function supportedHtmlSource(resolution: PaperResolution): FullTextSource | undefined {
  return resolution.full_text_sources.find((source) => {
    if (source.provider !== "europe_pmc" || source.format !== "html" || source.acquisition_route !== "clipper_core") return false;
    if (source.requires_browser_session || source.requires_domain_permission) return false;
    try {
      const url = new URL(source.url);
      return url.protocol === "https:"
        && !url.username
        && !url.password
        && url.hostname.toLowerCase() === ALLOWED_FULL_TEXT_HOST
        && /^\/articles\/PMC\d+\/$/i.test(url.pathname)
        && !url.search;
    } catch {
      return false;
    }
  });
}

async function responseBytes(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximumBytes) throw new Error(`${label} exceeds the safe size limit`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response has no body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel(`${label} exceeds the safe size limit`);
        throw new Error(`${label} exceeds the safe size limit`);
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
  return bytes;
}

function fetchablePmcImage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return isFetchableImageUrl(url) && (host === "pmc.ncbi.nlm.nih.gov" || host.endsWith(".ncbi.nlm.nih.gov"));
}

export class IngestManager {
  private readonly jobs = new Map<string, InternalIngestJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly fetchImplementation: typeof fetch;
  private readonly publisher: typeof publishClippingPackage;
  private readonly prepareStorage: (jobRoot: string, packagesRoot: string) => Promise<void>;

  constructor(
    private readonly config: ProcessingServiceConfig,
    private readonly resolver: PaperResolverLike,
    options: IngestManagerOptions = {}
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.publisher = options.publish ?? publishClippingPackage;
    this.prepareStorage = options.prepareStorage ?? (async (jobRoot, packagesRoot) => {
      await mkdir(jobRoot, { recursive: true });
      await mkdir(packagesRoot, { recursive: true });
    });
  }

  create(queryText: string): IngestJob {
    const active = [...this.jobs.values()].filter((job) => !["ready", "needs_attention", "failed", "cancelled"].includes(job.task.state)).length;
    if (active >= this.config.maximumActiveJobs) throw new Error("The ingest queue is currently full");
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: InternalIngestJob = {
      task: {
        job_id: id,
        state: "queued",
        query: parsePaperQuery(queryText),
        created_at: now,
        updated_at: now,
        message: "Paper ingest queued"
      },
      attemptedSources: []
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    queueMicrotask(() => this.drain());
    return publicTask(job);
  }

  get(id: string): IngestJob | undefined {
    const job = this.jobs.get(id);
    return job ? publicTask(job) : undefined;
  }

  getPackage(id: string): PublishedPackageDescriptor | undefined {
    const job = [...this.jobs.values()].find((candidate) => candidate.task.package_id === id && candidate.task.state === "ready");
    return job ? publicPackage(job) : undefined;
  }

  packageFilePath(packageId: string, relativePath: string): string | undefined {
    const job = [...this.jobs.values()].find((candidate) => candidate.task.package_id === packageId && candidate.task.state === "ready");
    if (!job?.package || !job.publishedRoot || !job.package.files.some((file) => file.path === relativePath)) return undefined;
    return join(job.publishedRoot, ...relativePath.split("/"));
  }

  private transition(job: InternalIngestJob, state: IngestJob["state"], message: string, values: Partial<IngestJob> = {}): void {
    assertIngestStateTransition(job.task.state, state);
    job.task = { ...job.task, ...values, state, message, updated_at: new Date().toISOString() };
  }

  private drain(): void {
    while (this.running < this.config.maximumActiveJobs) {
      const id = this.queue.shift();
      if (!id) return;
      const job = this.jobs.get(id);
      if (!job || job.task.state !== "queued") continue;
      this.running += 1;
      void this.process(job).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async fetchHtml(source: FullTextSource): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.resolverTimeoutMilliseconds);
    try {
      const response = await this.fetchImplementation(source.url, {
        method: "GET",
        headers: { Accept: "text/html", "User-Agent": "Paper2MD-Reader/0.1" },
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Full-text provider returned HTTP ${response.status}`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (mime !== "text/html" && mime !== "application/xhtml+xml") throw new Error("Full-text provider did not return HTML");
      return responseBytes(response, MAX_FULL_TEXT_BYTES, "Full-text HTML");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async localizeImages(markdown: string, sourceUrl: string): Promise<Map<string, LocalizedImage>> {
    const occurrences = collectMarkdownImages(markdown, sourceUrl);
    if (occurrences.length > MAX_CLIPPED_IMAGES) throw new Error(`Article contains more than ${MAX_CLIPPED_IMAGES} images`);
    const urls = [...new Set(occurrences.flatMap((occurrence) => occurrence.absoluteUrl ? [occurrence.absoluteUrl] : []))];
    const localized = new Map<string, LocalizedImage>();
    let totalBytes = 0;
    for (const urlText of urls) {
      const url = new URL(urlText);
      if (!fetchablePmcImage(url)) continue;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.resolverTimeoutMilliseconds);
        try {
          const response = await this.fetchImplementation(url, {
            method: "GET",
            headers: { Accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp" },
            redirect: "error",
            signal: controller.signal
          });
          if (!response.ok) continue;
          const mime = response.headers.get("content-type") ?? "";
          const extension = extensionForMime(mime);
          if (!extension) continue;
          const bytes = await readResponseBytesWithinLimit(response, MAX_CLIPPED_IMAGE_BYTES);
          if (!bytes.byteLength || totalBytes + bytes.byteLength > MAX_CLIPPED_TOTAL_IMAGE_BYTES) continue;
          totalBytes += bytes.byteLength;
          localized.set(url.href, {
            url: url.href,
            path: `images/figure-${String(localized.size + 1).padStart(4, "0")}.${extension}`,
            mime: mime.split(";", 1)[0].trim().toLowerCase(),
            bytes
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // Image failure is recorded by the clipping manifest as an omission.
      }
    }
    return localized;
  }

  private attention(job: InternalIngestJob, problem: IngestProblem): void {
    this.transition(job, "needs_attention", problem.message, { problem });
  }

  private async process(job: InternalIngestJob): Promise<void> {
    try {
      this.transition(job, "resolving", "Resolving the paper identity and legal full-text sources");
      const resolution = await this.resolver.resolve(job.task.query.original);
      job.attemptedSources.push(...resolution.attempted_sources);
      if (resolution.status !== "resolved" || !resolution.match) {
        return this.attention(job, resolution.problem ?? boundedProblem(
          "PAPER_NOT_FOUND",
          "Paper resolution did not produce an exact match",
          job.attemptedSources,
          ["Verify the identifier and retry"]
        ));
      }
      this.transition(job, "matched", `Matched ${resolution.match.identity.title}`);
      const source = supportedHtmlSource(resolution);
      if (!source) {
        return this.attention(job, boundedProblem(
          "CLIPPER_UNSUPPORTED",
          "No supported session-free PMC HTML source is available for automatic ingest",
          job.attemptedSources,
          ["Open a supported full-text page with the Clipper extension", "Upload a legally obtained PDF for MinerU extraction"]
        ));
      }

      this.transition(job, "acquiring", "Acquiring verified open full-text HTML from PMC");
      const sourceHtml = await this.fetchHtml(source);
      job.attemptedSources.push({ provider: "pmc", locator: source.url, outcome: "available" });
      this.transition(job, "clipping", "Extracting article structure and localizing permitted images deterministically");
      const html = new TextDecoder().decode(sourceHtml);
      const result = await Defuddle(html, source.url, { markdown: true, useAsync: false });
      const markdown = typeof result.content === "string" ? result.content.trim() : "";
      if (markdown.length < 200) throw new Error("PMC HTML did not contain enough readable article content");
      const identity = resolution.match.identity;
      const page: ExtractedPaperPage = {
        title: identity.title,
        author: identity.authors.join(", "),
        published: identity.year ? String(identity.year) : "",
        description: typeof result.description === "string" ? result.description.trim() : "",
        sourceUrl: source.url,
        language: typeof result.language === "string" ? result.language.trim() : "",
        wordCount: Number.isFinite(result.wordCount) ? Number(result.wordCount) : 0,
        markdown
      };
      const localizedImages = await this.localizeImages(markdown, source.url);
      const clipping = await buildClippingPackageFiles({
        page,
        localizedImages,
        createdAt: new Date().toISOString(),
        extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false }
      });

      const packageId = randomUUID();
      const jobRoot = join(this.config.dataRoot, "ingest-jobs", job.task.job_id);
      const packageStage = join(jobRoot, "package-stage");
      const publishedRoot = join(this.config.dataRoot, "packages", packageId);
      await this.prepareStorage(jobRoot, join(this.config.dataRoot, "packages"));
      this.transition(job, "validating", "Validating the staged clipping package and immutable source snapshot");
      const descriptor = await this.publisher({
        packageId,
        label: identity.title,
        files: clipping.files,
        sourceHtml,
        packageStage,
        publishedRoot,
        onValidated: () => this.transition(job, "publishing", "Validation passed; atomically publishing the reading package")
      });
      job.package = descriptor;
      job.publishedRoot = publishedRoot;
      this.transition(job, "ready", "Paper package is ready", {
        package_id: packageId,
        reader_url: new URL(`/reader/${encodeURIComponent(packageId)}`, this.config.readerBaseUrl).href
      });
    } catch (error) {
      const validationPhase = job.task.state === "validating" || job.task.state === "publishing";
      const problem = boundedProblem(
        validationPhase ? "PACKAGE_VALIDATION_FAILED" : "EXTRACTION_FAILED",
        error instanceof Error ? error.message : "Paper ingest failed",
        job.attemptedSources,
        validationPhase
          ? ["Inspect the staged validation artifacts; no incomplete package was published"]
          : ["Retry later or use the Clipper extension / a legally obtained PDF"]
      );
      this.transition(job, "failed", problem.message, { problem });
    }
  }
}
