import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ConversionTask, DesktopRootSelection, StartConversionRequest } from "../shared/desktop-api";
import { ReviewedLayoutOptions, ReviewedWorkflowPaths, reviewedWorkflowPaths, safePaperStem } from "./reviewed-workflow";
import {
  parseTaskStoreJson,
  PersistedDesktopJob,
  PersistedDirectJob,
  PersistedRemoteMineruJob,
  persistentTask,
  PersistedReviewedJob,
  PersistedTaskEntry,
  reviewedRecoveryPoint,
  taskStoreJson
} from "./task-persistence";

const MAX_TASK_STORE_BYTES = 2 * 1024 * 1024;

export interface DirectJob {
  pdfPath: string;
  outputPath: string;
  request: Pick<StartConversionRequest, "backend" | "regionRenderMode">;
}

export interface ReviewedJob {
  pdfPath: string;
  paths: ReviewedWorkflowPaths;
  options: ReviewedLayoutOptions;
}

export interface RemoteMineruJob {
  packageId: string;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function availablePdf(path: string, maximumBytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && extname(path).toLowerCase() === ".pdf" && info.size <= maximumBytes;
  } catch {
    return false;
  }
}

export async function reviewPageCount(path: string): Promise<number | undefined> {
  try {
    const pages = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^page-\d+$/.test(entry.name));
    if (!pages.length) return undefined;
    const taskChecks = await Promise.all(pages.map((entry) => readableFile(join(path, entry.name, "layout-task.json"))));
    return taskChecks.every(Boolean) ? pages.length : undefined;
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function reviewedPathsAreConsistent(job: PersistedReviewedJob): boolean {
  const expected = reviewedWorkflowPaths(job.pdfPath, dirname(job.paths.workspacePath));
  return (
    samePath(job.paths.workspacePath, expected.workspacePath) &&
    samePath(job.paths.roiProposalPath, expected.roiProposalPath) &&
    samePath(job.paths.confirmedRoiPath, expected.confirmedRoiPath) &&
    samePath(job.paths.layoutReviewPath, expected.layoutReviewPath) &&
    samePath(job.paths.outputPath, expected.outputPath) &&
    job.paths.outputName === expected.outputName
  );
}

export class DesktopTaskStore {
  private persistenceReady = false;
  private persistenceQueue = Promise.resolve();
  private userDataPath: string | undefined;

  constructor(
    private readonly tasks: Map<string, ConversionTask>,
    private readonly directJobs: Map<string, DirectJob>,
    private readonly reviewedJobs: Map<string, ReviewedJob>,
    private readonly remoteMineruJobs: Map<string, RemoteMineruJob>,
    private readonly registerRoot: (path: string) => Promise<DesktopRootSelection>,
    private readonly remotePackageAvailable: (packageId: string) => Promise<boolean>,
    private readonly maximumPdfBytes: number
  ) {}

  schedulePersist(): void {
    if (!this.persistenceReady || !this.userDataPath) return;
    const snapshot = taskStoreJson(this.persistedEntries());
    const path = join(this.userDataPath, "desktop-tasks-v1.json");
    this.persistenceQueue = this.persistenceQueue
      .then(() => writeFile(path, snapshot, { encoding: "utf8", mode: 0o600 }))
      .catch((error) => console.error("Could not persist desktop tasks", error));
  }

  flush(): Promise<void> {
    return this.persistenceQueue;
  }

  async restore(userDataPath: string): Promise<void> {
    this.userDataPath = userDataPath;
    try {
      const path = join(userDataPath, "desktop-tasks-v1.json");
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_TASK_STORE_BYTES) throw new Error("Desktop task store exceeds the read limit");
      const parsed = parseTaskStoreJson(await readFile(path, "utf8"));
      parsed.diagnostics.forEach((diagnostic) => console.warn(diagnostic));
      const seen = new Set<string>();
      for (const entry of parsed.entries) {
        if (seen.has(entry.task.id)) {
          console.warn(`Ignored duplicate task ${entry.task.id}`);
          continue;
        }
        seen.add(entry.task.id);
        try {
          if (entry.job.kind === "direct") await this.restoreDirectTask(entry, entry.job);
          else if (entry.job.kind === "reviewed-layout") await this.restoreReviewedTask(entry, entry.job);
          else await this.restoreRemoteMineruTask(entry, entry.job);
        } catch (error) {
          console.warn(`Ignored task ${entry.task.id} during recovery`, error);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not restore desktop tasks", error);
    } finally {
      this.persistenceReady = true;
      this.schedulePersist();
    }
  }

  private persistedJob(taskId: string): PersistedDesktopJob | undefined {
    const direct = this.directJobs.get(taskId);
    if (direct) return { kind: "direct", ...direct };
    const reviewed = this.reviewedJobs.get(taskId);
    if (reviewed) return { kind: "reviewed-layout", ...reviewed };
    const remote = this.remoteMineruJobs.get(taskId);
    if (remote) return { kind: "mineru-remote", ...remote };
    return undefined;
  }

  private persistedEntries(): PersistedTaskEntry[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .flatMap((task) => {
        const job = this.persistedJob(task.id);
        return job ? [{ task: persistentTask(task), job }] : [];
      });
  }

  private async restoreDirectTask(entry: PersistedTaskEntry, job: PersistedDirectJob): Promise<void> {
    if (basename(job.outputPath) !== `${safePaperStem(job.pdfPath)}-paper2md`) {
      throw new Error("Direct task output path does not match its PDF");
    }
    this.directJobs.set(entry.task.id, { pdfPath: job.pdfPath, outputPath: job.outputPath, request: job.request });
    const outputReady = await readableFile(join(job.outputPath, "article.md"));
    let task: ConversionTask = { ...entry.task, recovered: true };
    if (outputReady) {
      const root = await this.registerRoot(job.outputPath);
      task = {
        ...task,
        stage: "complete",
        state: "succeeded",
        message: "Recovered completed direct conversion",
        packageRootId: root.id,
        artifactRootId: root.id,
        artifactLabel: "Recovered output"
      };
    } else if (["running", "queued", "succeeded"].includes(task.state)) {
      task = {
        ...task,
        stage: "direct-convert",
        state: "failed",
        message: "Direct conversion was interrupted; retry only after removing any partial output"
      };
    }
    this.tasks.set(task.id, task);
  }

  private async restoreReviewedTask(entry: PersistedTaskEntry, job: PersistedReviewedJob): Promise<void> {
    if (!reviewedPathsAreConsistent(job)) throw new Error("Reviewed task paths are inconsistent");
    this.reviewedJobs.set(entry.task.id, { pdfPath: job.pdfPath, paths: job.paths, options: job.options });
    const sourceReady = await availablePdf(job.pdfPath, this.maximumPdfBytes);
    const outputReady = await readableFile(join(job.paths.outputPath, "article.md"));
    const outputExists = await pathExists(job.paths.outputPath);
    const pageCount = await reviewPageCount(job.paths.layoutReviewPath);
    const recoveryPoint = reviewedRecoveryPoint({
      outputReady,
      outputExists,
      layoutReviewReady: pageCount !== undefined,
      confirmedRoiReady: await readableFile(job.paths.confirmedRoiPath),
      roiProposalReady: await readableFile(join(job.paths.roiProposalPath, "content-roi.json"))
    });
    let task: ConversionTask = { ...entry.task, recovered: true };

    if (recoveryPoint === "complete") {
      const root = await this.registerRoot(job.paths.outputPath);
      task = { ...task, stage: "complete", state: "succeeded", message: "Recovered completed reviewed package", packageRootId: root.id, artifactRootId: root.id, artifactLabel: "Recovered output" };
    } else if (recoveryPoint === "partial-output") {
      const root = await this.registerRoot(job.paths.outputPath);
      task = { ...task, stage: "layout-apply", state: "failed", message: "Layout apply was interrupted; partial output must be inspected and removed before retry", artifactRootId: root.id, artifactLabel: "Partial output" };
    } else if (recoveryPoint === "layout-review") {
      const root = await this.registerRoot(job.paths.layoutReviewPath);
      task = {
        ...task,
        stage: "layout-review",
        state: sourceReady ? "awaiting-review" : "failed",
        message: sourceReady ? `Recovered ${pageCount} page review tasks; confirm final-layout.json files before building` : "Recovered layout review files, but the source PDF is unavailable",
        artifactRootId: root.id,
        artifactLabel: "Recovered layout review package"
      };
    } else if (recoveryPoint === "layout-prepare") {
      task = { ...task, stage: "layout-prepare", state: "failed", message: sourceReady ? "Layout preparation was interrupted; remove any partial 02-layout-review folder, then retry" : "Confirmed ROI was recovered, but the source PDF is unavailable" };
    } else if (recoveryPoint === "roi-review") {
      const root = await this.registerRoot(job.paths.roiProposalPath);
      task = {
        ...task,
        stage: "roi-review",
        state: sourceReady ? "awaiting-review" : "failed",
        message: sourceReady ? "Recovered ROI proposal; review and import a confirmed ROI" : "Recovered ROI proposal, but the source PDF is unavailable",
        artifactRootId: root.id,
        artifactLabel: "Recovered ROI proposal"
      };
    } else {
      task = { ...task, stage: "roi-proposal", state: "failed", message: sourceReady ? "ROI preparation was interrupted; remove any partial 01-roi-proposal folder, then retry" : "Reviewed task cannot resume because the source PDF is unavailable" };
    }
    this.tasks.set(task.id, task);
  }

  private async restoreRemoteMineruTask(entry: PersistedTaskEntry, job: PersistedRemoteMineruJob): Promise<void> {
    this.remoteMineruJobs.set(entry.task.id, { packageId: job.packageId });
    let task: ConversionTask = { ...entry.task, packageId: job.packageId, recovered: true };
    const packageReady = await this.remotePackageAvailable(job.packageId);
    if (packageReady) {
      task = {
        ...task,
        stage: "complete",
        state: "succeeded",
        message: "Recovered a validated MinerU package from the local library"
      };
    } else if (["running", "queued"].includes(task.state)) {
      task = {
        ...task,
        state: "cancelled",
        message: "Remote MinerU extraction was interrupted locally; no incomplete package was published"
      };
    } else if (task.state === "succeeded") {
      task = {
        ...task,
        state: "failed",
        message: "The published library package is unavailable or failed validation"
      };
    }
    this.tasks.set(task.id, task);
  }
}
