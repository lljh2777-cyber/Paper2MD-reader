import { randomUUID } from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { access, copyFile, lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, ipcMain, safeStorage, shell } from "electron";
import {
  ConversionTask,
  DESKTOP_CHANNELS,
  DesktopPdfSelection,
  DesktopPackagePdf,
  DesktopRootSelection,
  StartConversionRequest,
  StartRemoteMineruRequest,
  StartReviewedLayoutRequest
} from "../shared/desktop-api";
import { normalizeDesktopRelativePath, resolvePackagePath } from "./path-security";
import { selectSourcePdfName } from "./package-discovery";
import {
  layoutApplyArgs,
  layoutPrepareArgs,
  ReviewedLayoutOptions,
  reviewedWorkflowPaths,
  roiProposalArgs,
  safePaperStem,
  validateConfirmedRoi,
  validateLayoutArgs
} from "./reviewed-workflow";
import {
  availablePdf,
  DesktopTaskStore,
  DirectJob,
  readableFile,
  RemoteMineruJob,
  reviewPageCount,
  ReviewedJob
} from "./desktop-task-store";
import { DesktopLibraryManager } from "./desktop-library";
import { DesktopCredentialStore } from "./desktop-credential-store";
import { MineruRemoteError, type MineruRemoteOptions } from "../../../processing-service/src/mineru-api-client";
import {
  RemoteMineruCancelledError,
  runRemoteMineruWorkflow,
  type RemoteMineruPaths,
  type RemoteMineruStage
} from "../../../processing-service/src/remote-mineru-workflow";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_IPC_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ROI_BYTES = 2 * 1024 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const MAX_CONCURRENT_REMOTE_TASKS = 2;
const roots = new Map<string, string>();
const pdfs = new Map<string, string>();
const tasks = new Map<string, ConversionTask>();
const processes = new Map<string, ChildProcessWithoutNullStreams>();
const remoteCancellations = new Set<string>();
const activeRemoteTasks = new Set<string>();

const directJobs = new Map<string, DirectJob>();
const reviewedJobs = new Map<string, ReviewedJob>();
const remoteMineruJobs = new Map<string, RemoteMineruJob>();
const MINERU_TOKEN_PAGE = "https://mineru.net/apiManage/token";
let libraryManager: DesktopLibraryManager | undefined;
let credentialStore: DesktopCredentialStore | undefined;

class TaskCancelledError extends Error {}

function assertTrusted(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!url.startsWith("file://")) throw new Error("Untrusted IPC sender");
}

async function discoverSourcePdf(root: string): Promise<DesktopPackagePdf | undefined> {
  const packagedSourcePath = join(root, "_extraction", "source.pdf");
  const packagedSource = await lstat(packagedSourcePath).catch(() => undefined);
  if (packagedSource?.isFile() && !packagedSource.isSymbolicLink() && packagedSource.size <= MAX_PDF_BYTES) {
    return { relativePath: "_extraction/source.pdf", name: "source.pdf", size: packagedSource.size };
  }
  const entries = await readdir(root, { withFileTypes: true });
  const name = selectSourcePdfName(entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name));
  if (!name) return undefined;
  const info = await stat(join(root, name));
  if (!info.isFile() || info.size > MAX_PDF_BYTES) return undefined;
  return { relativePath: name, name, size: info.size };
}

async function registerRoot(path: string, includeSourcePdf = false): Promise<DesktopRootSelection> {
  const canonical = await realpath(path);
  const sourcePdf = includeSourcePdf ? await discoverSourcePdf(canonical) : undefined;
  const id = randomUUID();
  roots.set(id, canonical);
  return {
    id,
    label: basename(canonical),
    sourcePdf
  };
}

const taskStore = new DesktopTaskStore(
  tasks,
  directJobs,
  reviewedJobs,
  remoteMineruJobs,
  registerRoot,
  async (packageId) => {
    try {
      await requireLibraryManager().packageRoot(packageId);
      return true;
    } catch {
      return false;
    }
  },
  MAX_PDF_BYTES
);

function requireLibraryManager(): DesktopLibraryManager {
  if (!libraryManager) throw new Error("Paper2MD library manager is not ready");
  return libraryManager;
}

function requireCredentialStore(): DesktopCredentialStore {
  if (!credentialStore) throw new Error("Paper2MD credential store is not ready");
  return credentialStore;
}

function requireRoot(id: string): string {
  const root = roots.get(id);
  if (!root) throw new Error("Unknown package root");
  return root;
}

function requirePdf(id: string): string {
  const path = pdfs.get(id);
  if (!path) throw new Error("Unknown PDF selection");
  return path;
}

function requireTask(id: string): ConversionTask {
  const task = tasks.get(id);
  if (!task) throw new Error("Unknown conversion task");
  return task;
}

function requireReviewedJob(id: string): ReviewedJob {
  const job = reviewedJobs.get(id);
  if (!job) throw new Error("Unknown reviewed-layout task");
  return job;
}

function emitTask(task: ConversionTask): void {
  tasks.set(task.id, task);
  taskStore.schedulePersist();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(DESKTOP_CHANNELS.taskUpdate, task);
  });
}

function updateTask(id: string, values: Partial<ConversionTask>): ConversionTask {
  const current = requireTask(id);
  const next = { ...current, ...values, updatedAt: new Date().toISOString() };
  emitTask(next);
  return next;
}

async function pickDirectory(title: string, includeSourcePdf = false): Promise<DesktopRootSelection | undefined> {
  const result = await dialog.showOpenDialog({ title, properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return registerRoot(result.filePaths[0], includeSourcePdf);
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Output already exists: ${basename(path)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function paper2mdCommand(): string {
  return process.env.PAPER2MD_EXECUTABLE || (process.platform === "win32" ? "paper2md.exe" : "paper2md");
}

function runPaper2md(taskId: string, args: string[]): Promise<string> {
  const child = spawn(paper2mdCommand(), args, { windowsHide: true, shell: false });
  processes.set(taskId, child);
  let log = "";
  let settled = false;
  const append = (chunk: Buffer) => {
    log = `${log}${chunk.toString("utf8")}`.slice(-MAX_LOG_CHARS);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      processes.delete(taskId);
      callback();
    };
    child.once("error", (error) => finish(() => reject(new Error(`Could not start Paper2MD: ${error.message}`))));
    child.once("close", (code) => finish(() => {
      if (tasks.get(taskId)?.state === "cancelled") {
        reject(new TaskCancelledError("Task cancelled"));
      } else if (code === 0) {
        resolve(log.trim());
      } else {
        reject(new Error(log.trim() || `Paper2MD exited with code ${code}`));
      }
    }));
  });
}

function failTask(taskId: string, error: unknown): void {
  if (error instanceof TaskCancelledError || tasks.get(taskId)?.state === "cancelled") return;
  updateTask(taskId, {
    state: "failed",
    message: error instanceof Error ? error.message : "Paper2MD workflow failed"
  });
}

function remoteStage(stage: RemoteMineruStage): ConversionTask["stage"] {
  return {
    upload: "remote-upload",
    extract: "remote-extract",
    download: "remote-download",
    validate: "remote-validate",
    publish: "remote-publish"
  }[stage] as ConversionTask["stage"];
}

async function runRemoteExtraction(
  taskId: string,
  pdfPath: string,
  paths: RemoteMineruPaths,
  options: MineruRemoteOptions
): Promise<void> {
  activeRemoteTasks.add(taskId);
  try {
    const token = await requireCredentialStore().requireToken();
    await runRemoteMineruWorkflow({
      packageId: taskId,
      filename: basename(pdfPath),
      originalPdfPath: pdfPath,
      token,
      options,
      paths,
      contractWorkerPath: join(__dirname, "reader-contract-worker.cjs"),
      timeoutSeconds: 900
    }, {
      isCancelled: () => remoteCancellations.has(taskId),
      onStage: (stage, message) => {
        if (tasks.get(taskId)?.state === "running") updateTask(taskId, { stage: remoteStage(stage), message });
      }
    });
    if (remoteCancellations.has(taskId)) throw new RemoteMineruCancelledError();
    const publishedRoot = await requireLibraryManager().packageRoot(taskId);
    const root = await registerRoot(publishedRoot, true);
    updateTask(taskId, {
      stage: "complete",
      state: "succeeded",
      message: "MinerU extraction passed validation and was published to the local library",
      packageId: taskId,
      packageRootId: root.id,
      artifactRootId: root.id,
      artifactLabel: "Published library package"
    });
  } catch (error) {
    if (error instanceof RemoteMineruCancelledError || remoteCancellations.has(taskId)) return;
    updateTask(taskId, {
      state: "failed",
      message: error instanceof MineruRemoteError
        ? error.message
        : "Remote extraction or deterministic package validation failed; no incomplete package was published"
    });
  } finally {
    activeRemoteTasks.delete(taskId);
    remoteCancellations.delete(taskId);
  }
}

async function runDirectConversion(
  taskId: string,
  pdfPath: string,
  outputPath: string,
  request: Pick<StartConversionRequest, "backend" | "regionRenderMode">
): Promise<void> {
  try {
    await runPaper2md(taskId, [
      "convert",
      pdfPath,
      outputPath,
      "--backend",
      request.backend,
      "--region-render-mode",
      request.regionRenderMode
    ]);
    await access(join(outputPath, "article.md"));
    const root = await registerRoot(outputPath);
    updateTask(taskId, {
      stage: "complete",
      state: "succeeded",
      message: "Conversion finished",
      packageRootId: root.id
    });
  } catch (error) {
    failTask(taskId, error);
  }
}

async function runRoiProposal(taskId: string): Promise<void> {
  const job = requireReviewedJob(taskId);
  try {
    await runPaper2md(taskId, roiProposalArgs(job.pdfPath, job.paths, job.options));
    await access(join(job.paths.roiProposalPath, "content-roi.json"));
    const root = await registerRoot(job.paths.roiProposalPath);
    updateTask(taskId, {
      stage: "roi-review",
      state: "awaiting-review",
      message: "Review content-roi.json and page ROI previews, then import the confirmed ROI",
      artifactRootId: root.id,
      artifactLabel: "ROI proposal"
    });
  } catch (error) {
    failTask(taskId, error);
  }
}

async function runLayoutPreparation(taskId: string): Promise<void> {
  const job = requireReviewedJob(taskId);
  try {
    await runPaper2md(taskId, layoutPrepareArgs(job.pdfPath, job.paths, job.options));
    const pageDirectories = (await readdir(job.paths.layoutReviewPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^page-\d+$/.test(entry.name));
    if (!pageDirectories.length) throw new Error("Paper2MD produced no page review tasks");
    await Promise.all(pageDirectories.map((entry) => access(join(job.paths.layoutReviewPath, entry.name, "layout-task.json"))));
    const root = await registerRoot(job.paths.layoutReviewPath);
    updateTask(taskId, {
      stage: "layout-review",
      state: "awaiting-review",
      message: `${pageDirectories.length} page review tasks are ready; add final-layout.json to every page`,
      artifactRootId: root.id,
      artifactLabel: "Layout review package"
    });
  } catch (error) {
    failTask(taskId, error);
  }
}

async function runValidationAndApply(taskId: string): Promise<void> {
  const job = requireReviewedJob(taskId);
  try {
    const pageDirectories = (await readdir(job.paths.layoutReviewPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^page-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (!pageDirectories.length) throw new Error("Layout review package has no page tasks");
    for (let index = 0; index < pageDirectories.length; index += 1) {
      const pagePath = join(job.paths.layoutReviewPath, pageDirectories[index]);
      const taskPath = join(pagePath, "layout-task.json");
      const finalLayoutPath = join(pagePath, "final-layout.json");
      await Promise.all([access(taskPath), access(finalLayoutPath)]).catch(() => {
        throw new Error(`${pageDirectories[index]} is missing layout-task.json or final-layout.json`);
      });
      updateTask(taskId, {
        stage: "layout-validation",
        state: "running",
        message: `Validating page ${index + 1} of ${pageDirectories.length}`
      });
      await runPaper2md(taskId, validateLayoutArgs(taskPath, finalLayoutPath));
    }
    await assertPathAbsent(job.paths.outputPath);
    updateTask(taskId, {
      stage: "layout-apply",
      state: "running",
      message: "All page layouts passed; building the reviewed package"
    });
    await runPaper2md(taskId, layoutApplyArgs(job.pdfPath, job.paths, job.options));
    await access(join(job.paths.outputPath, "article.md"));
    const root = await registerRoot(job.paths.outputPath);
    updateTask(taskId, {
      stage: "complete",
      state: "succeeded",
      message: "Reviewed layout package finished",
      packageRootId: root.id,
      artifactRootId: root.id,
      artifactLabel: "Reviewed output"
    });
  } catch (error) {
    failTask(taskId, error);
  }
}

function validateReviewedOptions(request: StartReviewedLayoutRequest): ReviewedLayoutOptions {
  if (
    request.backend !== "pdfium" ||
    !["fast", "standard", "forensic"].includes(request.extractionProfile) ||
    !["visual-direct", "candidate-assisted"].includes(request.reviewMode) ||
    !["keep", "omit", "separate"].includes(request.references) ||
    !["minimal", "standard", "full"].includes(request.evidence) ||
    typeof request.includeSourcePdf !== "boolean"
  ) {
    throw new Error("Unsupported reviewed-layout options");
  }
  return {
    backend: request.backend,
    extractionProfile: request.extractionProfile,
    reviewMode: request.reviewMode,
    references: request.references,
    evidence: request.evidence,
    includeSourcePdf: request.includeSourcePdf
  };
}

function installIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.getLibrarySnapshot, async (event) => {
    assertTrusted(event);
    return requireLibraryManager().snapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.chooseLibrary, async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog({
      title: "Choose or create a Paper2MD library folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length !== 1) return undefined;
    return requireLibraryManager().select(result.filePaths[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.openLibraryDocument, async (event, packageId: string) => {
    assertTrusted(event);
    const root = await requireLibraryManager().packageRoot(packageId);
    return registerRoot(root, true);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setLibraryFavorite, async (event, packageId: string, favorite: boolean) => {
    assertTrusted(event);
    if (typeof favorite !== "boolean") throw new Error("favorite must be a boolean");
    return requireLibraryManager().setFavorite(packageId, favorite);
  });
  ipcMain.handle(DESKTOP_CHANNELS.revealLibrary, async (event) => {
    assertTrusted(event);
    const error = await shell.openPath(await requireLibraryManager().revealPath());
    if (error) throw new Error(error);
  });
  ipcMain.handle(DESKTOP_CHANNELS.getMineruCredentialStatus, async (event) => {
    assertTrusted(event);
    return requireCredentialStore().status();
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveMineruCredential, async (event, token: string) => {
    assertTrusted(event);
    return requireCredentialStore().save(token);
  });
  ipcMain.handle(DESKTOP_CHANNELS.clearMineruCredential, async (event) => {
    assertTrusted(event);
    return requireCredentialStore().clear();
  });
  ipcMain.handle(DESKTOP_CHANNELS.openMineruTokenPage, async (event) => {
    assertTrusted(event);
    await shell.openExternal(MINERU_TOKEN_PAGE, { activate: true });
  });
  ipcMain.handle(DESKTOP_CHANNELS.choosePackage, async (event) => {
    assertTrusted(event);
    return pickDirectory("Open Paper2MD package or MinerU result folder", true);
  });
  ipcMain.handle(DESKTOP_CHANNELS.chooseOutputParent, async (event) => {
    assertTrusted(event);
    return pickDirectory("Choose output parent folder");
  });
  ipcMain.handle(DESKTOP_CHANNELS.choosePdf, async (event): Promise<DesktopPdfSelection | undefined> => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog({
      title: "Choose a born-digital PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF documents", extensions: ["pdf"] }]
    });
    if (result.canceled || result.filePaths.length !== 1) return undefined;
    const path = await realpath(result.filePaths[0]);
    const info = await stat(path);
    if (!info.isFile() || extname(path).toLowerCase() !== ".pdf" || info.size > MAX_PDF_BYTES) {
      throw new Error("Selected PDF is unavailable or exceeds the 256 MiB desktop limit");
    }
    const id = randomUUID();
    pdfs.set(id, path);
    return { id, name: basename(path), size: info.size };
  });
  ipcMain.handle(DESKTOP_CHANNELS.fileExists, async (event, rootId: string, path: string) => {
    assertTrusted(event);
    try {
      await access(await resolvePackagePath(requireRoot(rootId), path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.fileInfo, async (event, rootId: string, path: string) => {
    assertTrusted(event);
    try {
      const info = await stat(await resolvePackagePath(requireRoot(rootId), path));
      return info.isFile() ? { size: info.size } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.readText, async (event, rootId: string, path: string) => {
    assertTrusted(event);
    const target = await resolvePackagePath(requireRoot(rootId), path);
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_IPC_FILE_BYTES) throw new Error("File exceeds desktop read limit");
    return readFile(target, "utf8");
  });
  ipcMain.handle(DESKTOP_CHANNELS.readBinary, async (event, rootId: string, path: string) => {
    assertTrusted(event);
    const target = await resolvePackagePath(requireRoot(rootId), path);
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_IPC_FILE_BYTES) throw new Error("File exceeds desktop read limit");
    return new Uint8Array(await readFile(target));
  });
  ipcMain.handle(DESKTOP_CHANNELS.listFiles, async (event, rootId: string, directory: string) => {
    assertTrusted(event);
    const normalized = directory ? normalizeDesktopRelativePath(directory) : "";
    const root = requireRoot(rootId);
    const target = normalized ? await resolvePackagePath(root, normalized) : root;
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => normalized ? `${normalized}/${entry.name}` : entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.readPackagePdf, async (event, rootId: string, path: string) => {
    assertTrusted(event);
    const target = await resolvePackagePath(requireRoot(rootId), path);
    const info = await stat(target);
    if (!info.isFile() || extname(target).toLowerCase() !== ".pdf" || info.size > MAX_PDF_BYTES) {
      throw new Error("Package PDF is unavailable or exceeds the 256 MiB desktop limit");
    }
    return new Uint8Array(await readFile(target));
  });
  ipcMain.handle(DESKTOP_CHANNELS.readPdf, async (event, pdfId: string) => {
    assertTrusted(event);
    const path = requirePdf(pdfId);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new Error("PDF exceeds desktop preview limit");
    return new Uint8Array(await readFile(path));
  });
  ipcMain.handle(DESKTOP_CHANNELS.listTasks, (event) => {
    assertTrusted(event);
    return [...tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelTask, (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    if (task.workflow === "mineru-remote" && task.state === "running") {
      if (task.stage === "remote-publish") {
        throw new Error("Atomic publication has started and can no longer be cancelled");
      }
      remoteCancellations.add(taskId);
      updateTask(taskId, {
        state: "cancelled",
        message: "Cancelled locally; MinerU may finish its already submitted remote task, but Paper2MD will not publish it"
      });
      return true;
    }
    const child = processes.get(taskId);
    if (!child || child.exitCode !== null) return false;
    child.kill();
    updateTask(taskId, { state: "cancelled", message: "Cancelled by user" });
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.removeTask, (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    if (["running", "queued", "awaiting-review"].includes(task.state)) {
      throw new Error("Active or review-pending tasks cannot be removed");
    }
    if (task.packageRootId) roots.delete(task.packageRootId);
    if (task.artifactRootId) roots.delete(task.artifactRootId);
    tasks.delete(taskId);
    directJobs.delete(taskId);
    reviewedJobs.delete(taskId);
    remoteMineruJobs.delete(taskId);
    if (!activeRemoteTasks.has(taskId)) remoteCancellations.delete(taskId);
    taskStore.schedulePersist();
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.resumeTask, async (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    if (!["failed", "cancelled"].includes(task.state)) throw new Error("Only failed or cancelled tasks can be retried");
    const direct = directJobs.get(taskId);
    if (direct) {
      if (!await availablePdf(direct.pdfPath, MAX_PDF_BYTES)) throw new Error("Source PDF is unavailable");
      await assertPathAbsent(direct.outputPath);
      const next = updateTask(taskId, {
        stage: "direct-convert",
        state: "running",
        message: "Retrying direct conversion"
      });
      void runDirectConversion(taskId, direct.pdfPath, direct.outputPath, direct.request);
      return next;
    }
    const reviewed = requireReviewedJob(taskId);
    if (!await availablePdf(reviewed.pdfPath, MAX_PDF_BYTES)) throw new Error("Source PDF is unavailable");
    if (task.stage === "roi-review") {
      if (!await readableFile(join(reviewed.paths.roiProposalPath, "content-roi.json"))) {
        throw new Error("ROI proposal is unavailable");
      }
      return updateTask(taskId, {
        state: "awaiting-review",
        message: "ROI proposal is ready for confirmation"
      });
    }
    if (task.stage === "roi-proposal") {
      await assertPathAbsent(reviewed.paths.roiProposalPath);
      const next = updateTask(taskId, {
        state: "running",
        message: "Retrying the ROI proposal"
      });
      void runRoiProposal(taskId);
      return next;
    }
    if (task.stage === "layout-prepare") {
      if (!await readableFile(reviewed.paths.confirmedRoiPath)) throw new Error("Confirmed ROI is unavailable");
      await assertPathAbsent(reviewed.paths.layoutReviewPath);
      const next = updateTask(taskId, {
        state: "running",
        message: "Retrying layout review preparation"
      });
      void runLayoutPreparation(taskId);
      return next;
    }
    if (["layout-review", "layout-validation", "layout-apply"].includes(task.stage)) {
      if (await reviewPageCount(reviewed.paths.layoutReviewPath) === undefined) {
        throw new Error("Layout review package is incomplete");
      }
      await assertPathAbsent(reviewed.paths.outputPath);
      const next = updateTask(taskId, {
        stage: "layout-validation",
        state: "running",
        message: "Retrying layout validation and package build"
      });
      void runValidationAndApply(taskId);
      return next;
    }
    throw new Error("This task stage cannot be retried safely");
  });
  ipcMain.handle(DESKTOP_CHANNELS.startConversion, async (event, request: StartConversionRequest) => {
    assertTrusted(event);
    if (request.backend !== "pdfium" || !["off", "auto"].includes(request.regionRenderMode)) {
      throw new Error("Unsupported conversion options");
    }
    const pdfPath = requirePdf(request.pdfId);
    const outputParent = requireRoot(request.outputParentId);
    const outputPath = join(outputParent, `${safePaperStem(pdfPath)}-paper2md`);
    await assertPathAbsent(outputPath);
    const now = new Date().toISOString();
    const task: ConversionTask = {
      id: randomUUID(),
      pdfName: basename(pdfPath),
      outputName: basename(outputPath),
      workflow: "direct",
      stage: "direct-convert",
      state: "running",
      createdAt: now,
      updatedAt: now,
      message: "Paper2MD is processing the PDF"
    };
    directJobs.set(task.id, {
      pdfPath,
      outputPath,
      request: { backend: request.backend, regionRenderMode: request.regionRenderMode }
    });
    emitTask(task);
    void runDirectConversion(task.id, pdfPath, outputPath, request);
    return task;
  });
  ipcMain.handle(DESKTOP_CHANNELS.startRemoteMineru, async (event, request: StartRemoteMineruRequest) => {
    assertTrusted(event);
    if (activeRemoteTasks.size >= MAX_CONCURRENT_REMOTE_TASKS) {
      throw new Error("At most two remote MinerU extractions can run at the same time");
    }
    if (
      !request || !["pipeline", "vlm"].includes(request.model) ||
      !["en", "ch"].includes(request.language) || typeof request.ocr !== "boolean"
    ) throw new Error("Unsupported MinerU extraction options");
    const pdfPath = requirePdf(request.pdfId);
    const info = await lstat(pdfPath);
    const signature = Buffer.alloc(5);
    const pdfHandle = await open(pdfPath, "r");
    try {
      await pdfHandle.read(signature, 0, signature.byteLength, 0);
    } finally {
      await pdfHandle.close();
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size < 5 || info.size > MAX_PDF_BYTES
      || signature.toString("ascii") !== "%PDF-") {
      throw new Error("The selected file is not a safe PDF within the desktop size limit");
    }
    await requireCredentialStore().requireToken();
    await requireLibraryManager().revealPath();
    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "Send PDF to MinerU?",
      message: `Upload ${basename(pdfPath)} to the remote MinerU service?`,
      detail: "The PDF will leave this device. MinerU usage and fees belong to your account. Paper2MD will only publish the result after deterministic local validation.",
      buttons: ["Upload and extract", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (confirmation.response !== 0) return undefined;
    const id = randomUUID();
    const paths = await requireLibraryManager().allocateMineruPaths(id);
    const now = new Date().toISOString();
    const task: ConversionTask = {
      id,
      pdfName: basename(pdfPath),
      outputName: safePaperStem(pdfPath),
      workflow: "mineru-remote",
      stage: "remote-upload",
      state: "running",
      createdAt: now,
      updatedAt: now,
      message: "Preparing the authorized PDF for remote MinerU extraction"
    };
    remoteMineruJobs.set(id, { packageId: id });
    emitTask(task);
    void runRemoteExtraction(id, pdfPath, paths, {
      model: request.model,
      language: request.language,
      ocr: request.ocr,
      formula: true,
      table: true
    });
    return task;
  });
  ipcMain.handle(DESKTOP_CHANNELS.startReviewedLayout, async (event, request: StartReviewedLayoutRequest) => {
    assertTrusted(event);
    const options = validateReviewedOptions(request);
    const pdfPath = requirePdf(request.pdfId);
    const paths = reviewedWorkflowPaths(pdfPath, requireRoot(request.outputParentId));
    await assertPathAbsent(paths.workspacePath);
    await mkdir(paths.workspacePath);
    const now = new Date().toISOString();
    const task: ConversionTask = {
      id: randomUUID(),
      pdfName: basename(pdfPath),
      outputName: paths.outputName,
      workflow: "reviewed-layout",
      stage: "roi-proposal",
      state: "running",
      createdAt: now,
      updatedAt: now,
      message: "Preparing a non-destructive content ROI proposal"
    };
    reviewedJobs.set(task.id, { pdfPath, paths, options });
    emitTask(task);
    void runRoiProposal(task.id);
    return task;
  });
  ipcMain.handle(DESKTOP_CHANNELS.importConfirmedRoi, async (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    const job = requireReviewedJob(taskId);
    if (task.state !== "awaiting-review" || task.stage !== "roi-review") {
      throw new Error("This task is not waiting for a confirmed ROI");
    }
    const result = await dialog.showOpenDialog({
      title: "Import confirmed content-roi.json",
      properties: ["openFile"],
      filters: [{ name: "JSON documents", extensions: ["json"] }]
    });
    if (result.canceled || result.filePaths.length !== 1) return undefined;
    const selectedPath = await realpath(result.filePaths[0]);
    const info = await stat(selectedPath);
    if (!info.isFile() || info.size > MAX_ROI_BYTES) throw new Error("Reviewed ROI exceeds the 2 MiB limit");
    const proposalText = await readFile(join(job.paths.roiProposalPath, "content-roi.json"), "utf8");
    const reviewedText = await readFile(selectedPath, "utf8");
    let proposalValue: unknown;
    let reviewedValue: unknown;
    try {
      proposalValue = JSON.parse(proposalText);
      reviewedValue = JSON.parse(reviewedText);
    } catch {
      throw new Error("ROI files must contain valid JSON");
    }
    validateConfirmedRoi(proposalValue, reviewedValue);
    await assertPathAbsent(job.paths.confirmedRoiPath);
    await copyFile(selectedPath, job.paths.confirmedRoiPath);
    const next = updateTask(taskId, {
      stage: "layout-prepare",
      state: "running",
      message: "Confirmed ROI imported; preparing per-page visual review tasks"
    });
    void runLayoutPreparation(taskId);
    return next;
  });
  ipcMain.handle(DESKTOP_CHANNELS.revealTaskArtifacts, async (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    if (!task.artifactRootId) throw new Error("This task has no review artifacts yet");
    const error = await shell.openPath(requireRoot(task.artifactRootId));
    if (error) throw new Error(error);
  });
  ipcMain.handle(DESKTOP_CHANNELS.validateAndApplyLayout, async (event, taskId: string) => {
    assertTrusted(event);
    const task = requireTask(taskId);
    requireReviewedJob(taskId);
    if (task.state !== "awaiting-review" || task.stage !== "layout-review") {
      throw new Error("This task is not waiting for page layout results");
    }
    const next = updateTask(taskId, {
      stage: "layout-validation",
      state: "running",
      message: "Checking every page review result"
    });
    void runValidationAndApply(taskId);
    return next;
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.removeMenu();
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(__dirname, "renderer/index.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath("userData");
  libraryManager = new DesktopLibraryManager(userDataPath);
  credentialStore = new DesktopCredentialStore(join(userDataPath, "mineru-credential-v1.json"), {
    available: () => safeStorage.isEncryptionAvailable()
      && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (value) => new Uint8Array(safeStorage.encryptString(value)),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
  });
  await libraryManager.restore();
  await taskStore.restore(userDataPath);
  installIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let shutdownPersistenceStarted = false;
app.on("before-quit", (event) => {
  if (shutdownPersistenceStarted) return;
  event.preventDefault();
  processes.forEach((child, taskId) => {
    if (child.exitCode === null) child.kill();
    if (tasks.get(taskId)?.state === "running") {
      updateTask(taskId, {
        state: "cancelled",
        message: "Interrupted when the desktop app closed; retry from the recorded stage"
      });
    }
  });
  activeRemoteTasks.forEach((taskId) => {
    if (tasks.get(taskId)?.stage === "remote-publish") return;
    remoteCancellations.add(taskId);
    if (tasks.get(taskId)?.state === "running") {
      updateTask(taskId, {
        state: "cancelled",
        message: "Interrupted when the desktop app closed; no incomplete remote package was published"
      });
    }
  });
  shutdownPersistenceStarted = true;
  void taskStore.flush().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
