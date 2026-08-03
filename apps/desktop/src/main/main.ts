import { randomUUID } from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, ipcMain } from "electron";
import {
  ConversionTask,
  DESKTOP_CHANNELS,
  DesktopPdfSelection,
  DesktopRootSelection,
  StartConversionRequest
} from "../shared/desktop-api";
import { normalizeDesktopRelativePath, resolvePackagePath } from "./path-security";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_IPC_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const roots = new Map<string, string>();
const pdfs = new Map<string, string>();
const tasks = new Map<string, ConversionTask>();
const processes = new Map<string, ChildProcessWithoutNullStreams>();

function assertTrusted(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!url.startsWith("file://")) throw new Error("Untrusted IPC sender");
}

async function registerRoot(path: string): Promise<DesktopRootSelection> {
  const canonical = await realpath(path);
  const id = randomUUID();
  roots.set(id, canonical);
  return { id, label: basename(canonical) };
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

function emitTask(task: ConversionTask): void {
  tasks.set(task.id, task);
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(DESKTOP_CHANNELS.taskUpdate, task);
  });
}

function updateTask(id: string, values: Partial<ConversionTask>): ConversionTask {
  const current = tasks.get(id);
  if (!current) throw new Error("Unknown conversion task");
  const next = { ...current, ...values, updatedAt: new Date().toISOString() };
  emitTask(next);
  return next;
}

async function pickDirectory(title: string): Promise<DesktopRootSelection | undefined> {
  const result = await dialog.showOpenDialog({ title, properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return registerRoot(result.filePaths[0]);
}

function installIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.choosePackage, async (event) => {
    assertTrusted(event);
    return pickDirectory("Open Paper2MD package");
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
    const normalized = normalizeDesktopRelativePath(directory);
    const root = requireRoot(rootId);
    const target = await resolvePackagePath(root, normalized);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => `${normalized}/${entry.name}`)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
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
    const process = processes.get(taskId);
    if (!process || process.exitCode !== null) return false;
    process.kill();
    updateTask(taskId, { state: "cancelled", message: "Cancelled by user" });
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.startConversion, async (event, request: StartConversionRequest) => {
    assertTrusted(event);
    if (request.backend !== "pdfium" || !["off", "auto"].includes(request.regionRenderMode)) {
      throw new Error("Unsupported conversion options");
    }
    const pdfPath = requirePdf(request.pdfId);
    const outputParent = requireRoot(request.outputParentId);
    const stem = basename(pdfPath, extname(pdfPath)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "paper";
    const outputPath = join(outputParent, `${stem}-paper2md`);
    try {
      await access(outputPath);
      throw new Error(`Output already exists: ${basename(outputPath)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const task: ConversionTask = {
      id: randomUUID(),
      pdfName: basename(pdfPath),
      outputName: basename(outputPath),
      state: "queued",
      createdAt: now,
      updatedAt: now,
      message: "Waiting for Paper2MD"
    };
    emitTask(task);
    const command = process.env.PAPER2MD_EXECUTABLE || (process.platform === "win32" ? "paper2md.exe" : "paper2md");
    const child = spawn(command, [
      "convert",
      pdfPath,
      outputPath,
      "--backend",
      request.backend,
      "--region-render-mode",
      request.regionRenderMode
    ], { windowsHide: true, shell: false });
    processes.set(task.id, child);
    updateTask(task.id, { state: "running", message: "Paper2MD is processing the PDF" });
    let log = "";
    const append = (chunk: Buffer) => {
      log = `${log}${chunk.toString("utf8")}`.slice(-MAX_LOG_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      processes.delete(task.id);
      updateTask(task.id, { state: "failed", message: `Could not start Paper2MD: ${error.message}` });
    });
    child.once("close", async (code) => {
      processes.delete(task.id);
      if (tasks.get(task.id)?.state === "cancelled") return;
      if (code !== 0) {
        updateTask(task.id, { state: "failed", message: log.trim() || `Paper2MD exited with code ${code}` });
        return;
      }
      try {
        await access(join(outputPath, "article.md"));
        const root = await registerRoot(outputPath);
        updateTask(task.id, { state: "succeeded", message: "Conversion finished", packageRootId: root.id });
      } catch {
        updateTask(task.id, { state: "failed", message: "Paper2MD finished without a readable article.md" });
      }
    });
    return tasks.get(task.id)!;
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

app.whenReady().then(() => {
  installIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
