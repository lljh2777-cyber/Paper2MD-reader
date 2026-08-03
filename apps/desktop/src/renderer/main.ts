import "../../../../styles.css";
import "../../../../local-reader/local-reader.css";
import "./desktop.css";
import { mountReaderWorkspace } from "../../../../packages/reader-ui/src/index";
import { ConversionTask, DesktopPdfSelection } from "../shared/desktop-api";
import { DesktopPackagePicker } from "./desktop-package-picker";
import { ElectronReaderFileSystem } from "./electron-reader-file-system";

const api = window.paper2mdDesktop;
const root = document.querySelector<HTMLElement>("#desktop-app");
if (!root) throw new Error("Desktop application root is missing");

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const shell = element("div", "p2md-desktop-shell");
const taskRail = element("aside", "p2md-desktop-task-rail");
const taskHeader = element("header", "p2md-desktop-task-header");
const taskTitle = element("h1");
taskTitle.textContent = "Paper2MD tasks";
const taskCopy = element("p");
taskCopy.textContent = "Process a local born-digital PDF, then open its output without leaving the desktop app.";
const processButton = element("button", "p2md-desktop-process-button");
processButton.type = "button";
processButton.textContent = "Process PDF (direct)";
const taskList = element("div", "p2md-desktop-task-list");
taskHeader.append(taskTitle, taskCopy, processButton);
taskRail.append(taskHeader, taskList);

const readerHost = element("section", "p2md-desktop-reader");
const pdfPane = element("aside", "p2md-desktop-pdf-pane");
const pdfHeader = element("header", "p2md-desktop-pdf-header");
const pdfLabel = element("strong");
pdfLabel.textContent = "PDF preview";
pdfHeader.appendChild(pdfLabel);
let pdfContent: HTMLElement = element("div", "p2md-desktop-pdf-empty");
pdfContent.textContent = "Choose Process PDF to preview the source document here.";
pdfPane.append(pdfHeader, pdfContent);
shell.append(taskRail, readerHost, pdfPane);
root.appendChild(shell);

const workspace = mountReaderWorkspace(readerHost, {
  picker: new DesktopPackagePicker(api),
  title: "Paper2MD Reader Desktop",
  emptyTitle: "Open or process a paper",
  emptyCopy: "Open an existing Paper2MD package, or process a local PDF from the task panel.",
  emptyNote: "Local filesystem access is isolated behind the desktop adapter",
  openLabel: "Open package"
});

const tasks = new Map<string, ConversionTask>();
let pdfUrl: string | undefined;

function renderTasks(): void {
  taskList.replaceChildren();
  const ordered = [...tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (!ordered.length) {
    const empty = element("p");
    empty.textContent = "No conversion tasks yet.";
    taskList.appendChild(empty);
    return;
  }
  ordered.forEach((task) => {
    const item = element("article", "p2md-desktop-task");
    item.dataset.state = task.state;
    const name = element("strong");
    name.textContent = task.pdfName;
    const state = element("span");
    state.textContent = `${task.state} · ${task.message}`;
    item.append(name, state);
    const actions = element("div", "p2md-desktop-task-actions");
    if (task.state === "succeeded" && task.packageRootId) {
      const open = element("button", "p2md-desktop-task-action");
      open.type = "button";
      open.textContent = "Open result";
      open.addEventListener("click", () => {
        void workspace.attachFileSystem(new ElectronReaderFileSystem(api, {
          id: task.packageRootId!,
          label: task.outputName
        }));
      });
      actions.appendChild(open);
    }
    if (task.state === "running" || task.state === "queued") {
      const cancel = element("button", "p2md-desktop-task-action");
      cancel.type = "button";
      cancel.dataset.tone = "quiet";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => void api.cancelTask(task.id));
      actions.appendChild(cancel);
    }
    if (actions.childElementCount) item.appendChild(actions);
    taskList.appendChild(item);
  });
}

async function showPdf(pdf: DesktopPdfSelection): Promise<void> {
  const bytes = await api.readPdf(pdf.id);
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  pdfUrl = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
  pdfLabel.textContent = pdf.name;
  const frame = element("iframe", "p2md-desktop-pdf-frame");
  frame.title = `PDF preview: ${pdf.name}`;
  frame.src = pdfUrl;
  pdfContent.replaceWith(frame);
  pdfContent = frame;
}

async function startConversion(): Promise<void> {
  processButton.disabled = true;
  processButton.textContent = "Selecting…";
  try {
    const pdf = await api.choosePdf();
    if (!pdf) return;
    await showPdf(pdf);
    const outputParent = await api.chooseOutputParent();
    if (!outputParent) return;
    const task = await api.startConversion({
      pdfId: pdf.id,
      outputParentId: outputParent.id,
      backend: "pdfium",
      regionRenderMode: "off"
    });
    tasks.set(task.id, task);
    renderTasks();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start Paper2MD";
    const failed: ConversionTask = {
      id: `local-${Date.now()}`,
      pdfName: "Conversion request",
      outputName: "",
      state: "failed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message
    };
    tasks.set(failed.id, failed);
    renderTasks();
  } finally {
    processButton.disabled = false;
    processButton.textContent = "Process PDF (direct)";
  }
}

processButton.addEventListener("click", () => void startConversion());
const stopTaskUpdates = api.onTaskUpdate((task) => {
  tasks.set(task.id, task);
  renderTasks();
});
void api.listTasks().then((existing) => {
  existing.forEach((task) => tasks.set(task.id, task));
  renderTasks();
});
renderTasks();

window.addEventListener("beforeunload", () => {
  stopTaskUpdates();
  workspace.destroy();
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
}, { once: true });
