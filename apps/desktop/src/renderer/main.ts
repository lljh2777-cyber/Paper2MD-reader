import "../../../../styles.css";
import "../../../../local-reader/local-reader.css";
import "./desktop.css";
import { mountReaderWorkspace } from "../../../../packages/reader-ui/src/index";
import {
  ConversionTask,
  DesktopPdfSelection,
  EvidenceLevel,
  ExtractionProfile,
  LayoutReviewMode,
  ReferencePolicy
} from "../shared/desktop-api";
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

function optionSelect<T extends string>(labelText: string, values: Array<{ value: T; label: string }>): {
  wrapper: HTMLLabelElement;
  select: HTMLSelectElement;
} {
  const wrapper = element("label", "p2md-desktop-option");
  const label = element("span");
  label.textContent = labelText;
  const select = element("select");
  values.forEach(({ value, label: optionLabel }) => {
    const option = element("option");
    option.value = value;
    option.textContent = optionLabel;
    select.appendChild(option);
  });
  wrapper.append(label, select);
  return { wrapper, select };
}

const shell = element("div", "p2md-desktop-shell");
const taskRail = element("aside", "p2md-desktop-task-rail");
const taskHeader = element("header", "p2md-desktop-task-header");
const taskTitle = element("h1");
taskTitle.textContent = "Paper2MD tasks";
const taskCopy = element("p");
taskCopy.textContent = "Use direct conversion, or pause at ROI and layout review gates for an auditable visual workflow.";

const optionsPanel = element("div", "p2md-desktop-options");
const profileControl = optionSelect<ExtractionProfile>("Extraction", [
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast" },
  { value: "forensic", label: "Forensic" }
]);
const reviewModeControl = optionSelect<LayoutReviewMode>("Review input", [
  { value: "visual-direct", label: "Visual direct" },
  { value: "candidate-assisted", label: "Candidate assisted" }
]);
const referencesControl = optionSelect<ReferencePolicy>("References", [
  { value: "keep", label: "Keep" },
  { value: "separate", label: "Separate" },
  { value: "omit", label: "Omit" }
]);
const evidenceControl = optionSelect<EvidenceLevel>("Evidence", [
  { value: "standard", label: "Standard" },
  { value: "minimal", label: "Minimal" },
  { value: "full", label: "Full" }
]);
const sourcePdfControl = element("label", "p2md-desktop-check");
const sourcePdfInput = element("input");
sourcePdfInput.type = "checkbox";
const sourcePdfText = element("span");
sourcePdfText.textContent = "Include source PDF";
sourcePdfControl.append(sourcePdfInput, sourcePdfText);
optionsPanel.append(
  profileControl.wrapper,
  reviewModeControl.wrapper,
  referencesControl.wrapper,
  evidenceControl.wrapper,
  sourcePdfControl
);

const reviewedButton = element("button", "p2md-desktop-process-button");
reviewedButton.type = "button";
reviewedButton.textContent = "Start reviewed layout";
const processButton = element("button", "p2md-desktop-process-button");
processButton.type = "button";
processButton.dataset.tone = "secondary";
processButton.textContent = "Process PDF (direct)";
const taskList = element("div", "p2md-desktop-task-list");
taskHeader.append(taskTitle, taskCopy, optionsPanel, reviewedButton, processButton);
taskRail.append(taskHeader, taskList);

const readerHost = element("section", "p2md-desktop-reader");
const pdfPane = element("aside", "p2md-desktop-pdf-pane");
const pdfHeader = element("header", "p2md-desktop-pdf-header");
const pdfLabel = element("strong");
pdfLabel.textContent = "PDF preview";
pdfHeader.appendChild(pdfLabel);
let pdfContent: HTMLElement = element("div", "p2md-desktop-pdf-empty");
pdfContent.textContent = "Choose a workflow to preview the source document here.";
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
const taskErrors = new Map<string, string>();
let pdfUrl: string | undefined;

function actionButton(label: string, callback: () => Promise<void>, tone?: "quiet"): HTMLButtonElement {
  const button = element("button", "p2md-desktop-task-action");
  button.type = "button";
  button.textContent = label;
  if (tone) button.dataset.tone = tone;
  button.addEventListener("click", () => {
    button.disabled = true;
    void callback().catch((error) => {
      const item = button.closest<HTMLElement>("[data-task-id]");
      if (item?.dataset.taskId) {
        taskErrors.set(item.dataset.taskId, error instanceof Error ? error.message : "Task action failed");
        renderTasks();
      }
    }).finally(() => {
      button.disabled = false;
    });
  });
  return button;
}

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
    const managedTask = !task.id.startsWith("local-");
    const item = element("article", "p2md-desktop-task");
    item.dataset.state = task.state;
    item.dataset.taskId = task.id;
    const name = element("strong");
    name.textContent = task.pdfName;
    const workflow = element("small");
    const recoveryLabel = task.recovered ? " · recovered" : "";
    workflow.textContent = task.workflow === "reviewed-layout"
      ? `Reviewed · ${task.stage}${recoveryLabel}`
      : `Direct conversion${recoveryLabel}`;
    const state = element("span");
    state.textContent = `${task.state} · ${task.message}`;
    item.append(name, workflow, state);
    const actionError = taskErrors.get(task.id);
    if (actionError) {
      const error = element("span", "p2md-desktop-task-error");
      error.textContent = actionError;
      item.appendChild(error);
    }
    const actions = element("div", "p2md-desktop-task-actions");
    if (task.state === "succeeded" && task.packageRootId) {
      actions.appendChild(actionButton("Open result", async () => {
        await workspace.attachFileSystem(new ElectronReaderFileSystem(api, {
          id: task.packageRootId!,
          label: task.outputName
        }));
      }));
    }
    if (task.artifactRootId) {
      actions.appendChild(actionButton(
        task.state === "succeeded" ? "Show files" : "Open review folder",
        () => api.revealTaskArtifacts(task.id),
        "quiet"
      ));
    }
    if (task.state === "awaiting-review" && task.stage === "roi-review") {
      actions.appendChild(actionButton("Import confirmed ROI", async () => {
        const updated = await api.importConfirmedRoi(task.id);
        if (updated) {
          taskErrors.delete(task.id);
          tasks.set(updated.id, updated);
          renderTasks();
        }
      }));
    }
    if (task.state === "awaiting-review" && task.stage === "layout-review") {
      actions.appendChild(actionButton("Validate & build", async () => {
        const updated = await api.validateAndApplyLayout(task.id);
        taskErrors.delete(task.id);
        tasks.set(updated.id, updated);
        renderTasks();
      }));
    }
    if (task.state === "running" || task.state === "queued") {
      actions.appendChild(actionButton("Cancel", async () => {
        await api.cancelTask(task.id);
      }, "quiet"));
    }
    if (managedTask && (task.state === "failed" || task.state === "cancelled")) {
      actions.appendChild(actionButton("Retry", async () => {
        const updated = await api.resumeTask(task.id);
        taskErrors.delete(task.id);
        tasks.set(updated.id, updated);
        renderTasks();
      }));
    }
    if (managedTask && ["succeeded", "failed", "cancelled"].includes(task.state)) {
      actions.appendChild(actionButton("Remove record", async () => {
        if (await api.removeTask(task.id)) {
          taskErrors.delete(task.id);
          tasks.delete(task.id);
          renderTasks();
        }
      }, "quiet"));
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

function addRequestError(message: string): void {
  const now = new Date().toISOString();
  const failed: ConversionTask = {
    id: `local-${Date.now()}`,
    pdfName: "Workflow request",
    outputName: "",
    workflow: "direct",
    stage: "direct-convert",
    state: "failed",
    createdAt: now,
    updatedAt: now,
    message
  };
  tasks.set(failed.id, failed);
  renderTasks();
}

async function chooseWorkflowInputs(): Promise<{ pdf: DesktopPdfSelection; outputParentId: string } | undefined> {
  const pdf = await api.choosePdf();
  if (!pdf) return undefined;
  await showPdf(pdf);
  const outputParent = await api.chooseOutputParent();
  if (!outputParent) return undefined;
  return { pdf, outputParentId: outputParent.id };
}

async function startDirectConversion(): Promise<void> {
  setStartButtonsDisabled(true, "Selecting…");
  try {
    const input = await chooseWorkflowInputs();
    if (!input) return;
    const task = await api.startConversion({
      pdfId: input.pdf.id,
      outputParentId: input.outputParentId,
      backend: "pdfium",
      regionRenderMode: "off"
    });
    tasks.set(task.id, task);
    renderTasks();
  } catch (error) {
    addRequestError(error instanceof Error ? error.message : "Could not start Paper2MD");
  } finally {
    setStartButtonsDisabled(false);
  }
}

async function startReviewedLayout(): Promise<void> {
  setStartButtonsDisabled(true, "Selecting…");
  try {
    const input = await chooseWorkflowInputs();
    if (!input) return;
    const task = await api.startReviewedLayout({
      pdfId: input.pdf.id,
      outputParentId: input.outputParentId,
      backend: "pdfium",
      extractionProfile: profileControl.select.value as ExtractionProfile,
      reviewMode: reviewModeControl.select.value as LayoutReviewMode,
      references: referencesControl.select.value as ReferencePolicy,
      evidence: evidenceControl.select.value as EvidenceLevel,
      includeSourcePdf: sourcePdfInput.checked
    });
    tasks.set(task.id, task);
    renderTasks();
  } catch (error) {
    addRequestError(error instanceof Error ? error.message : "Could not start reviewed layout");
  } finally {
    setStartButtonsDisabled(false);
  }
}

function setStartButtonsDisabled(disabled: boolean, temporaryLabel?: string): void {
  reviewedButton.disabled = disabled;
  processButton.disabled = disabled;
  reviewedButton.textContent = temporaryLabel ?? "Start reviewed layout";
  processButton.textContent = temporaryLabel ?? "Process PDF (direct)";
}

processButton.addEventListener("click", () => void startDirectConversion());
reviewedButton.addEventListener("click", () => void startReviewedLayout());
const stopTaskUpdates = api.onTaskUpdate((task) => {
  taskErrors.delete(task.id);
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
