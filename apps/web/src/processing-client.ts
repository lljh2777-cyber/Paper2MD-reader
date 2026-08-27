import type { ReaderProcessingProgress } from "../../../packages/reader-core/src/index";
import type { ProcessingJob } from "../../../packages/agent-contracts/src/index";
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
  constructor(private readonly apiBaseUrl: string) {}

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

  private async fetchService(input: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(input, init);
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
