import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MineruJobOptions, ProcessingJob } from "./contracts";
import { ProcessingServiceConfig } from "./config";
import { mineruExtractArgs, runMineru } from "./mineru-runner";
import { publishMineruPackage } from "./package-publisher";

interface InternalJob {
  task: ProcessingJob;
  options: MineruJobOptions;
  jobRoot: string;
  sourcePath: string;
  extractRoot: string;
  packageStage: string;
  publishedRoot: string;
  process?: ChildProcess;
}

export interface UploadAllocation {
  job: ProcessingJob;
  sourcePath: string;
}

export function safePdfFilename(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("PDF filename has invalid encoding");
  }
  const base = decoded.replace(/\\/g, "/").split("/").pop()?.trim() || "paper.pdf";
  const normalized = base.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "");
  if (!normalized.toLowerCase().endsWith(".pdf")) throw new Error("Only PDF uploads are accepted");
  return normalized.slice(0, 240) || "paper.pdf";
}

function publicTask(job: InternalJob): ProcessingJob {
  return structuredClone(job.task);
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(private readonly config: ProcessingServiceConfig) {}

  async allocateUpload(filename: string, options: MineruJobOptions): Promise<UploadAllocation> {
    const active = [...this.jobs.values()].filter((job) => job.task.state === "queued" || job.task.state === "running").length;
    if (active >= this.config.maximumActiveJobs) throw new Error("The processing queue is currently full");
    const id = randomUUID();
    const jobRoot = join(this.config.dataRoot, "jobs", id);
    const sourcePath = join(jobRoot, "source.pdf");
    const now = new Date().toISOString();
    const internal: InternalJob = {
      task: {
        id,
        filename: safePdfFilename(filename),
        state: "queued",
        stage: "extract",
        message: "PDF uploaded; waiting for MinerU",
        createdAt: now,
        updatedAt: now
      },
      options,
      jobRoot,
      sourcePath,
      extractRoot: join(jobRoot, "extract"),
      packageStage: join(jobRoot, "package-stage"),
      publishedRoot: join(jobRoot, "package")
    };
    await mkdir(jobRoot, { recursive: true });
    this.jobs.set(id, internal);
    return { job: publicTask(internal), sourcePath };
  }

  async submitAcquiredPdf(filename: string, bytes: Uint8Array, options: MineruJobOptions): Promise<ProcessingJob> {
    if (bytes.byteLength < 5 || bytes.byteLength > this.config.maximumPdfBytes
      || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error("Acquired content is not a valid PDF within the configured size limit");
    }
    const allocation = await this.allocateUpload(filename, options);
    try {
      await writeFile(allocation.sourcePath, bytes, { flag: "wx", mode: 0o600 });
      return this.enqueue(allocation.job.id);
    } catch (error) {
      this.failUpload(allocation.job.id);
      throw error;
    }
  }

  async waitForTerminal(id: string, timeoutMilliseconds: number): Promise<ProcessingJob> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const task = this.get(id);
      if (!task) throw new Error("Unknown processing job");
      if (task.state !== "queued" && task.state !== "running") return task;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("MinerU processing did not reach a terminal state before the ingest deadline");
  }

  enqueue(id: string): ProcessingJob {
    const job = this.requireJob(id);
    if (job.task.state !== "queued" || this.queue.includes(id)) return publicTask(job);
    this.queue.push(id);
    queueMicrotask(() => void this.drain());
    return publicTask(job);
  }

  failUpload(id: string): void {
    const job = this.requireJob(id);
    this.update(job, { state: "failed", message: "PDF upload failed before processing began" });
  }

  get(id: string): ProcessingJob | undefined {
    const job = this.jobs.get(id);
    return job ? publicTask(job) : undefined;
  }

  getPackage(id: string) {
    const job = this.jobs.get(id);
    return job?.task.state === "succeeded" && job.task.package ? structuredClone(job.task.package) : undefined;
  }

  packageFilePath(id: string, relativePath: string): string | undefined {
    const job = this.jobs.get(id);
    if (!job || job.task.state !== "succeeded" || !job.task.package) return undefined;
    if (!job.task.package.files.some((file) => file.path === relativePath)) return undefined;
    return join(job.publishedRoot, ...relativePath.split("/"));
  }

  private requireJob(id: string): InternalJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown processing job");
    return job;
  }

  private update(job: InternalJob, values: Partial<ProcessingJob>): void {
    job.task = { ...job.task, ...values, updatedAt: new Date().toISOString() };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    this.running = true;
    try {
      await this.process(this.requireJob(id));
    } finally {
      this.running = false;
      if (this.queue.length) queueMicrotask(() => void this.drain());
    }
  }

  private async process(job: InternalJob): Promise<void> {
    try {
      await mkdir(job.extractRoot, { recursive: false });
      this.update(job, { state: "running", stage: "extract", message: "MinerU 正在精确提取 Markdown、图片与结构数据…" });
      const args = mineruExtractArgs(
        job.sourcePath,
        job.extractRoot,
        job.options,
        this.config.mineruBaseUrl
      );
      await runMineru(
        this.config.mineruCommand,
        args,
        job.jobRoot,
        job.options.timeoutSeconds,
        (process) => { job.process = process; }
      );
      job.process = undefined;
      this.update(job, { stage: "validate", message: "正在生成视觉修复契约并执行完整性校验…" });
      const packageDescriptor = await publishMineruPackage({
        packageId: job.task.id,
        filename: job.task.filename,
        sourcePath: job.sourcePath,
        extractRoot: job.extractRoot,
        packageStage: job.packageStage,
        publishedRoot: job.publishedRoot,
        mineruOptions: {
          mode: "precision-extract",
          formats: ["md", "json"],
          model: job.options.model,
          language: job.options.language,
          formula: true,
          table: true,
          timeout_seconds: job.options.timeoutSeconds
        },
        pythonCommand: this.config.pythonCommand,
        contractTimeoutSeconds: Math.min(180, job.options.timeoutSeconds),
        onValidated: () => {
          this.update(job, { stage: "publish", message: "校验通过，正在原子发布阅读包…" });
        }
      });
      this.update(job, {
        state: "succeeded",
        stage: "complete",
        message: "PDF 已转换并通过校验",
        package: packageDescriptor
      });
    } catch (error) {
      job.process = undefined;
      console.error(`Processing job ${job.task.id} failed`, error);
      this.update(job, {
        state: "failed",
        message: "PDF 转换或校验失败；未发布任何不完整内容包"
      });
    }
  }
}
