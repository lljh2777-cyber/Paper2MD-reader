import type { ReaderProcessingProgress } from "../../../packages/reader-core/src/index";
import type { IngestJob, PaperResolution, ProcessingJob, VisualCorrectionInput } from "../../../packages/agent-contracts/src/index";
import { assertOpaqueId } from "../../../packages/agent-contracts/src/index";
import {
  RemotePackageDescriptor,
  RemotePackageReaderFileSystem
} from "./remote-package-reader-file-system";

const CLIENT_MAX_PDF_BYTES = 64 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1_000;

type RemoteProcessingJob = Omit<ProcessingJob, "package"> & { package?: RemotePackageDescriptor };

declare global {
  interface Window {
    __PAPER2MD_READER_CONFIG__?: {
      processingApiBaseUrl?: string;
    };
  }
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value, window.location.href);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PDF processing API must use HTTPS, except on loopback during local development");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function configuredProcessingApiBaseUrl(): string | undefined {
  const configured = window.__PAPER2MD_READER_CONFIG__?.processingApiBaseUrl?.trim();
  if (configured) return normalizeApiBaseUrl(configured);
  const loopback = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  return loopback ? "http://127.0.0.1:8787/api/v1" : undefined;
}

export class ProcessingClient {
  constructor(private readonly apiBaseUrl: string, private readonly fetchImplementation: typeof fetch = fetch) {}

  async resolvePaper(query: string): Promise<PaperResolution> {
    return this.command<PaperResolution>("resolve_paper", { query });
  }

  async ingestPaper(query: string): Promise<IngestJob> {
    return this.command<IngestJob>("ingest_paper", { query });
  }

  async getIngestJob(jobId: string): Promise<IngestJob> {
    return this.command<IngestJob>("get_ingest_job", { job_id: assertOpaqueId(jobId, "job_id") });
  }

  async waitForIngest(jobId: string, onUpdate: (job: IngestJob) => void): Promise<IngestJob> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let job = await this.getIngestJob(jobId);
    onUpdate(job);
    while (!["ready", "needs_attention", "failed", "cancelled"].includes(job.state)) {
      if (Date.now() >= deadline) throw new Error("Paper ingest timed out.");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      job = await this.getIngestJob(jobId);
      onUpdate(job);
    }
    return job;
  }

  async createClipperPairing(): Promise<{ pairing_id: string; code: string; expires_at: string }> {
    const response = await this.fetchService(`${this.apiBaseUrl}/clipper/pairings`, {
      method: "POST", credentials: "include", headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.pairing_id !== "string" || !/^[0-9a-f-]{36}$/.test(value.pairing_id)
      || typeof value.code !== "string" || !/^\d{8}$/.test(value.code)
      || typeof value.expires_at !== "string") throw new Error("Processing service returned an invalid pairing response.");
    return value as { pairing_id: string; code: string; expires_at: string };
  }

  async revokeClipperCredentials(): Promise<number> {
    const response = await this.fetchService(`${this.apiBaseUrl}/clipper/credentials/revoke`, {
      method: "POST", credentials: "include", headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    const value = await response.json() as { revoked?: unknown };
    if (!Number.isSafeInteger(value.revoked) || Number(value.revoked) < 0) throw new Error("Processing service returned an invalid revocation response.");
    return Number(value.revoked);
  }

  async readVisualReviewSidecar(packageId: string): Promise<unknown | undefined> {
    const safeId = assertOpaqueId(packageId, "package_id");
    const response = await this.fetchService(`${this.apiBaseUrl}/packages/${encodeURIComponent(safeId)}/sidecars/visual-review`, {
      credentials: "include", headers: { Accept: "application/json" }
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(await this.errorMessage(response));
    return response.json() as Promise<unknown>;
  }

  validateVisualCorrection(packageId: string, candidateId: string, correction: VisualCorrectionInput): Promise<Record<string, unknown>> {
    return this.command("validate_visual_correction", {
      package_id: assertOpaqueId(packageId, "package_id"),
      candidate_id: assertOpaqueId(candidateId, "candidate_id"),
      correction
    });
  }

  applyVisualCorrection(packageId: string, candidateId: string, correction: VisualCorrectionInput, validationToken: string): Promise<Record<string, unknown>> {
    return this.command("apply_visual_correction", {
      package_id: assertOpaqueId(packageId, "package_id"),
      candidate_id: assertOpaqueId(candidateId, "candidate_id"),
      correction,
      validation_token: assertOpaqueId(validationToken, "validation_token"),
      confirm: true
    });
  }

  async openPackage(packageId: string): Promise<RemotePackageReaderFileSystem> {
    const safeId = assertOpaqueId(packageId, "package_id");
    const response = await this.fetchService(`${this.apiBaseUrl}/packages/${encodeURIComponent(safeId)}`, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    const descriptor = await response.json() as Partial<RemotePackageDescriptor>;
    if (descriptor.packageId !== safeId || typeof descriptor.label !== "string" || !Array.isArray(descriptor.files)) {
      throw new Error("Processing service returned an invalid package descriptor.");
    }
    return new RemotePackageReaderFileSystem(
      descriptor.label,
      this.apiBaseUrl,
      safeId,
      descriptor.files
    );
  }

  async processPdf(file: File, onProgress: (progress: ReaderProcessingProgress) => void): Promise<RemotePackageReaderFileSystem> {
    if (file.size < 5 || file.size > CLIENT_MAX_PDF_BYTES) {
      throw new Error(`PDF size must be between 5 bytes and ${CLIENT_MAX_PDF_BYTES / 1024 / 1024} MB.`);
    }
    const signature = new TextDecoder("ascii").decode(await file.slice(0, 5).arrayBuffer());
    if (signature !== "%PDF-") throw new Error("The selected file is not a valid PDF.");

    onProgress({ state: "uploading", stage: "upload", message: "正在安全上传 PDF…" });
    const response = await this.fetchService(`${this.apiBaseUrl}/jobs`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/pdf",
        "X-Paper2MD-Filename": encodeURIComponent(file.name),
        "X-Paper2MD-Model": "vlm",
        "X-Paper2MD-Language": "en"
      },
      body: file
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    let job = await this.parseJob(response);
    onProgress({ state: job.state, stage: job.stage, message: job.message });

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (job.state === "queued" || job.state === "running") {
      if (Date.now() >= deadline) throw new Error("PDF processing timed out while waiting for MinerU.");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const poll = await this.fetchService(`${this.apiBaseUrl}/jobs/${encodeURIComponent(job.id)}`, {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!poll.ok) throw new Error(await this.errorMessage(poll));
      job = await this.parseJob(poll);
      onProgress({ state: job.state, stage: job.stage, message: job.message });
    }

    if (job.state !== "succeeded" || !job.package) {
      throw new Error(job.message || "MinerU processing failed.");
    }
    return this.openPackage(job.package.packageId);
  }

  private async parseJob(response: Response): Promise<RemoteProcessingJob> {
    const value = await response.json() as Partial<RemoteProcessingJob>;
    if (!value.id || !value.state || !value.stage || typeof value.message !== "string") {
      throw new Error("Processing service returned an invalid job response.");
    }
    return value as RemoteProcessingJob;
  }

  private async errorMessage(response: Response): Promise<string> {
    try {
      const value = await response.json() as { error?: unknown };
      if (typeof value.error === "string" && value.error) return value.error;
    } catch {
      // Fall through to a status-only error without exposing an HTML proxy response.
    }
    return `PDF processing request failed (${response.status}).`;
  }

  private async command<Result>(command: string, input: Record<string, unknown>): Promise<Result> {
    const response = await this.fetchService(`${this.apiBaseUrl}/commands`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ command, input })
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    const envelope = await response.json() as { command?: unknown; result?: unknown };
    if (envelope.command !== command || envelope.result === undefined) throw new Error("Processing service returned an invalid command response.");
    return envelope.result as Result;
  }

  private async fetchService(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(input, init);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      const endpoint = new URL(this.apiBaseUrl);
      const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
      const chinese = navigator.language.toLowerCase().startsWith("zh");
      if (loopback) {
        throw new Error(chinese
          ? "无法连接本地 PDF 处理服务。请在 E:\\Paper2MD-Reader 运行 npm run reader:dev，并保持该窗口开启。"
          : "The local PDF processing service is unavailable. Run npm run reader:dev in E:\\Paper2MD-Reader and keep that window open.");
      }
      throw new Error(chinese
        ? "无法连接已配置的 PDF 处理服务，请稍后重试。"
        : "The configured PDF processing service is unavailable. Please retry later.");
    }
  }
}
