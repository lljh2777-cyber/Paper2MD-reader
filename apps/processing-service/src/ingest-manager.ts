import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Defuddle } from "defuddle/node";
import { DOMParser } from "linkedom";
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
  planFullTextAcquisition,
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
import { safeAcquire, type SafeAcquisitionResponse } from "./safe-acquisition-fetch";

const MAX_FULL_TEXT_BYTES = 16 * 1024 * 1024;
const HTML_MIME = ["text/html", "application/xhtml+xml"] as const;
const XML_MIME = ["application/xml", "text/xml", "application/jats+xml"] as const;

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
  acquire?: typeof safeAcquire;
  publish?: typeof publishClippingPackage;
  processPdf?: (bytes: Uint8Array, filename: string) => Promise<PublishedPackageDescriptor>;
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
  private readonly acquire: typeof safeAcquire;
  private readonly processPdf?: (bytes: Uint8Array, filename: string) => Promise<PublishedPackageDescriptor>;
  private readonly prepareStorage: (jobRoot: string, packagesRoot: string) => Promise<void>;

  constructor(
    private readonly config: ProcessingServiceConfig,
    private readonly resolver: PaperResolverLike,
    options: IngestManagerOptions = {}
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.acquire = options.acquire ?? safeAcquire;
    this.publisher = options.publish ?? publishClippingPackage;
    this.processPdf = options.processPdf;
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

  private fetchDocument(source: FullTextSource): Promise<SafeAcquisitionResponse> {
    const accept = source.format === "xml" ? XML_MIME : source.format === "pdf" ? ["application/pdf"] : HTML_MIME;
    return this.acquire(source.url, {
      accept,
      maximumBytes: source.format === "pdf" ? this.config.maximumPdfBytes : MAX_FULL_TEXT_BYTES,
      timeoutMilliseconds: this.config.resolverTimeoutMilliseconds
    });
  }

  private async localizeImages(markdown: string, sourceUrl: string): Promise<Map<string, LocalizedImage>> {
    const occurrences = collectMarkdownImages(markdown, sourceUrl);
    if (occurrences.length > MAX_CLIPPED_IMAGES) throw new Error(`Article contains more than ${MAX_CLIPPED_IMAGES} images`);
    const urls = [...new Set(occurrences.flatMap((occurrence) => occurrence.absoluteUrl ? [occurrence.absoluteUrl] : []))];
    const localized = new Map<string, LocalizedImage>();
    let totalBytes = 0;
    for (const urlText of urls) {
      const url = new URL(urlText);
      if (!isFetchableImageUrl(url)) continue;
      try {
        if (fetchablePmcImage(url)) {
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
        } else {
          const response = await this.acquire(url.href, {
            accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"],
            maximumBytes: MAX_CLIPPED_IMAGE_BYTES,
            timeoutMilliseconds: this.config.resolverTimeoutMilliseconds
          });
          const extension = extensionForMime(response.mime);
          if (!extension || totalBytes + response.bytes.byteLength > MAX_CLIPPED_TOTAL_IMAGE_BYTES) continue;
          totalBytes += response.bytes.byteLength;
          localized.set(url.href, {
            url: response.finalUrl,
            path: `images/figure-${String(localized.size + 1).padStart(4, "0")}.${extension}`,
            mime: response.mime,
            bytes: response.bytes
          });
        }
      } catch {
        // Image failure is recorded by the clipping manifest as an omission.
      }
    }
    return localized;
  }

  private jatsMarkdown(xml: string, sourceUrl: string): { markdown: string; description: string; language: string } {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    const article = document?.querySelector("article");
    if (!article || document.querySelector("parsererror")) throw new Error("PMC XML is not a valid JATS article");
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    const title = clean(article.querySelector("article-title")?.textContent);
    if (title) lines.push(`# ${title}`, "");
    const abstract = article.querySelector("abstract");
    const abstractText = clean(abstract?.textContent);
    if (abstractText) lines.push("## Abstract", "", abstractText, "");
    article.querySelectorAll("body > sec").forEach((section: Element) => {
      const heading = clean(section.querySelector(":scope > title")?.textContent);
      if (heading) lines.push(`## ${heading}`, "");
      section.querySelectorAll(":scope > p, :scope > sec > p").forEach((paragraph: Element) => {
        const value = clean(paragraph.textContent);
        if (value) lines.push(value, "");
      });
      section.querySelectorAll("fig").forEach((figure: Element) => {
        const graphic = figure.querySelector("graphic");
        const href = graphic?.getAttribute("xlink:href") ?? graphic?.getAttribute("href");
        const label = clean(figure.querySelector("label")?.textContent) || "Figure";
        const caption = clean(figure.querySelector("caption")?.textContent);
        if (href) lines.push(`![${label}](${new URL(href, sourceUrl).href})`, "");
        if (caption) lines.push(`**${label}.** ${caption}`, "");
      });
    });
    return {
      markdown: lines.join("\n").trim(),
      description: abstractText,
      language: article.getAttribute("xml:lang") ?? ""
    };
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
      const plan = planFullTextAcquisition(resolution.full_text_sources);
      if (plan.kind === "clipper_extension") {
        return this.attention(job, boundedProblem(
          plan.source?.requires_browser_session ? "LOGIN_REQUIRED" : "DOMAIN_PERMISSION_REQUIRED",
          plan.reason,
          job.attemptedSources,
          ["Open the full-text page and explicitly authorize the Clipper extension for this domain"]
        ));
      }
      if (!plan.source || plan.kind === "unavailable") return this.attention(job, boundedProblem(
        "FULL_TEXT_NOT_AVAILABLE", plan.reason, job.attemptedSources,
        ["Open a supported full-text page with the Clipper extension", "Upload a legally obtained PDF for MinerU extraction"]
      ));

      const source = plan.source;
      this.transition(job, "acquiring", `Acquiring verified open full text from ${source.provider}`);
      const acquired = await this.fetchDocument(source);
      job.attemptedSources.push({ provider: source.provider, locator: acquired.finalUrl, outcome: "available" });
      if (plan.kind === "public_pdf") {
        if (!this.processPdf) throw new Error("Automatic open-PDF extraction is not configured");
        if (new TextDecoder("ascii").decode(acquired.bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Open PDF source has an invalid signature");
        this.transition(job, "extracting", "Running deterministic MinerU precision extraction on the staged open PDF");
        const filename = `${resolution.match.identity.identifiers.doi ?? resolution.match.identity.title.slice(0, 80)}.pdf`
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
        const descriptor = await this.processPdf(acquired.bytes, filename);
        job.package = descriptor;
        this.transition(job, "validating", "MinerU package validation completed in the isolated processing job");
        this.transition(job, "publishing", "Validated MinerU package was atomically published");
        return this.transition(job, "ready", "Paper package is ready", {
          package_id: descriptor.packageId,
          reader_url: new URL(`/reader/${encodeURIComponent(descriptor.packageId)}`, this.config.readerBaseUrl).href
        });
      }

      this.transition(job, "clipping", "Extracting article structure and localizing permitted images deterministically");
      const sourceHtml = acquired.bytes;
      const documentText = new TextDecoder().decode(sourceHtml);
      const extracted = plan.kind === "pmc_xml"
        ? this.jatsMarkdown(documentText, acquired.finalUrl)
        : await Defuddle(documentText, acquired.finalUrl, { markdown: true, useAsync: false });
      const markdown = "markdown" in extracted
        ? extracted.markdown.trim()
        : typeof extracted.content === "string" ? extracted.content.trim() : "";
      if (markdown.length < 200) throw new Error("PMC HTML did not contain enough readable article content");
      const identity = resolution.match.identity;
      const page: ExtractedPaperPage = {
        title: identity.title,
        author: identity.authors.join(", "),
        published: identity.year ? String(identity.year) : "",
        description: typeof extracted.description === "string" ? extracted.description.trim() : "",
        sourceUrl: acquired.finalUrl,
        language: typeof extracted.language === "string" ? extracted.language.trim() : "",
        wordCount: "wordCount" in extracted && Number.isFinite(extracted.wordCount) ? Number(extracted.wordCount) : 0,
        markdown
      };
      const localizedImages = await this.localizeImages(markdown, acquired.finalUrl);
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
