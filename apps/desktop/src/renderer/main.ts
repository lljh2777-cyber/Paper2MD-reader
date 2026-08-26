import "../../../../styles.css";
import "../../../../local-reader/local-reader.css";
import "katex/dist/katex.min.css";
import "./desktop.css";
import { mountReaderWorkspace } from "../../../../packages/reader-ui/src/index";
import {
  ConversionTask,
  DesktopPdfSelection,
  DesktopRootSelection,
  EvidenceLevel,
  ExtractionProfile,
  LayoutReviewMode,
  ReferencePolicy
} from "../shared/desktop-api";
import { DesktopPackagePicker } from "./desktop-package-picker";
import { ElectronReaderFileSystem } from "./electron-reader-file-system";
import {
  getReaderLocale,
  readerText,
  ReaderLocale,
  subscribeReaderLocale
} from "../../../../src/ui/locale";
import { desktopText, localizedTaskMessage, localizedTaskState } from "./desktop-copy";

const api = window.paper2mdDesktop;
const root = document.querySelector<HTMLElement>("#desktop-app");
if (!root) throw new Error("Desktop application root is missing");
let locale: ReaderLocale = getReaderLocale();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function optionSelect<T extends string>(labelText: string, values: Array<{ value: T; label: string }>): {
  wrapper: HTMLLabelElement;
  select: HTMLSelectElement;
  label: HTMLSpanElement;
  options: HTMLOptionElement[];
} {
  const wrapper = element("label", "p2md-desktop-option");
  const label = element("span");
  label.textContent = labelText;
  const select = element("select");
  const options = values.map(({ value, label: optionLabel }) => {
    const option = element("option");
    option.value = value;
    option.textContent = optionLabel;
    select.appendChild(option);
    return option;
  });
  wrapper.append(label, select);
  return { wrapper, select, label, options };
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
const rightPane = element("aside", "p2md-desktop-right-pane");
const rightTabs = element("div", "p2md-desktop-right-tabs");
rightTabs.setAttribute("role", "tablist");
const pdfTab = element("button", "p2md-desktop-right-tab");
pdfTab.type = "button";
pdfTab.setAttribute("role", "tab");
pdfTab.id = "p2md-desktop-pdf-tab";
pdfTab.setAttribute("aria-controls", "p2md-desktop-pdf-view");
const visualsTab = element("button", "p2md-desktop-right-tab");
visualsTab.type = "button";
visualsTab.setAttribute("role", "tab");
visualsTab.id = "p2md-desktop-visuals-tab";
visualsTab.setAttribute("aria-controls", "p2md-desktop-visuals-view");
rightTabs.append(pdfTab, visualsTab);

const pdfView = element("section", "p2md-desktop-right-view p2md-desktop-pdf-view");
pdfView.id = "p2md-desktop-pdf-view";
pdfView.setAttribute("role", "tabpanel");
pdfView.setAttribute("aria-labelledby", pdfTab.id);
const pdfHeader = element("header", "p2md-desktop-pdf-header");
const pdfLabel = element("strong");
pdfLabel.textContent = "PDF preview";
pdfHeader.appendChild(pdfLabel);
let pdfContent: HTMLElement = element("div", "p2md-desktop-pdf-empty");
pdfContent.textContent = "Open an existing result folder with a source PDF, or choose a PDF to start a conversion.";
pdfView.append(pdfHeader, pdfContent);

const figureHost = element("section", "p2md-desktop-right-view p2md-desktop-visuals-view p2md-figures-host");
figureHost.id = "p2md-desktop-visuals-view";
figureHost.setAttribute("role", "tabpanel");
figureHost.setAttribute("aria-labelledby", visualsTab.id);
rightPane.append(rightTabs, pdfView, figureHost);
shell.append(taskRail, readerHost, rightPane);
root.appendChild(shell);

const workspace = mountReaderWorkspace(readerHost, {
  picker: new DesktopPackagePicker(api, async (selectedRoot) => {
    await showPackagePdf(selectedRoot);
    setRightPaneMode("visuals");
  }),
  figureHost,
  localizedCopy: {
    en: {
      title: readerText("en", "desktopReaderTitle"),
      emptyTitle: readerText("en", "desktopEmptyTitle"),
      emptyCopy: readerText("en", "desktopEmptyCopy"),
      emptyNote: readerText("en", "desktopEmptyNote"),
      toolbarOpenLabel: readerText("en", "openPackage"),
      emptyOpenLabel: readerText("en", "openPackage"),
      unselectedLabel: readerText("en", "noPackageSelected")
    },
    "zh-CN": {
      title: readerText("zh-CN", "desktopReaderTitle"),
      emptyTitle: readerText("zh-CN", "desktopEmptyTitle"),
      emptyCopy: readerText("zh-CN", "desktopEmptyCopy"),
      emptyNote: readerText("zh-CN", "desktopEmptyNote"),
      toolbarOpenLabel: readerText("zh-CN", "openPackage"),
      emptyOpenLabel: readerText("zh-CN", "openPackage"),
      unselectedLabel: readerText("zh-CN", "noPackageSelected")
    }
  }
});

const tasks = new Map<string, ConversionTask>();
const taskErrors = new Map<string, string>();
let pdfUrl: string | undefined;
let selectedPdfName: string | undefined;
let pdfEmptyCopyKey: "previewEmpty" | "previewNoSource" | "previewLoadFailed" = "previewEmpty";
let startButtonsBusy = false;
type RightPaneMode = "pdf" | "visuals";
let rightPaneMode: RightPaneMode = "visuals";

function setRightPaneMode(mode: RightPaneMode): void {
  rightPaneMode = mode;
  const pdfSelected = mode === "pdf";
  pdfTab.dataset.selected = String(pdfSelected);
  pdfTab.setAttribute("aria-selected", String(pdfSelected));
  pdfTab.tabIndex = pdfSelected ? 0 : -1;
  visualsTab.dataset.selected = String(!pdfSelected);
  visualsTab.setAttribute("aria-selected", String(!pdfSelected));
  visualsTab.tabIndex = pdfSelected ? -1 : 0;
  pdfView.hidden = !pdfSelected;
  figureHost.hidden = pdfSelected;
}

pdfTab.addEventListener("click", () => setRightPaneMode("pdf"));
visualsTab.addEventListener("click", () => setRightPaneMode("visuals"));
rightTabs.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const mode = event.key === "ArrowLeft" || event.key === "Home" ? "pdf" : "visuals";
  setRightPaneMode(mode);
  (mode === "pdf" ? pdfTab : visualsTab).focus();
});
setRightPaneMode(rightPaneMode);

function updateOptionControl(
  control: { label: HTMLSpanElement; options: HTMLOptionElement[] },
  label: string,
  optionLabels: string[]
): void {
  control.label.textContent = label;
  control.options.forEach((option, index) => {
    option.textContent = optionLabels[index];
  });
}

function applyDesktopLocale(nextLocale: ReaderLocale): void {
  locale = nextLocale;
  document.title = readerText(locale, "desktopReaderTitle");
  taskTitle.textContent = desktopText(locale, "tasks");
  taskCopy.textContent = desktopText(locale, "taskCopy");
  updateOptionControl(profileControl, desktopText(locale, "extraction"), [
    desktopText(locale, "standard"), desktopText(locale, "fast"), desktopText(locale, "forensic")
  ]);
  updateOptionControl(reviewModeControl, desktopText(locale, "reviewInput"), [
    desktopText(locale, "visualDirect"), desktopText(locale, "candidateAssisted")
  ]);
  updateOptionControl(referencesControl, desktopText(locale, "references"), [
    desktopText(locale, "keep"), desktopText(locale, "separate"), desktopText(locale, "omit")
  ]);
  updateOptionControl(evidenceControl, desktopText(locale, "evidence"), [
    desktopText(locale, "standard"), desktopText(locale, "minimal"), desktopText(locale, "full")
  ]);
  sourcePdfText.textContent = desktopText(locale, "includeSourcePdf");
  rightPane.ariaLabel = desktopText(locale, "rightPane");
  rightTabs.ariaLabel = desktopText(locale, "rightPane");
  pdfTab.textContent = desktopText(locale, "originalPdf");
  visualsTab.textContent = desktopText(locale, "imagesAndCaptions");
  setStartButtonsDisabled(startButtonsBusy);
  if (!selectedPdfName) {
    pdfLabel.textContent = desktopText(locale, "pdfPreview");
    if (pdfContent.classList.contains("p2md-desktop-pdf-empty")) {
      pdfContent.textContent = desktopText(locale, pdfEmptyCopyKey);
    }
  }
  renderTasks();
}

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
    empty.textContent = desktopText(locale, "noTasks");
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
    const recoveryLabel = task.recovered ? ` · ${desktopText(locale, "recovered")}` : "";
    workflow.textContent = task.workflow === "reviewed-layout"
      ? `${desktopText(locale, "reviewed")} · ${task.stage}${recoveryLabel}`
      : `${desktopText(locale, "directConversion")}${recoveryLabel}`;
    const state = element("span");
    state.textContent = `${localizedTaskState(task, locale)} · ${localizedTaskMessage(task, locale)}`;
    item.append(name, workflow, state);
    const actionError = taskErrors.get(task.id);
    if (actionError) {
      const error = element("span", "p2md-desktop-task-error");
      error.textContent = actionError;
      item.appendChild(error);
    }
    const actions = element("div", "p2md-desktop-task-actions");
    if (task.state === "succeeded" && task.packageRootId) {
      actions.appendChild(actionButton(desktopText(locale, "openResult"), async () => {
        await workspace.attachFileSystem(new ElectronReaderFileSystem(api, {
          id: task.packageRootId!,
          label: task.outputName
        }));
      }));
    }
    if (task.artifactRootId) {
      actions.appendChild(actionButton(
        task.state === "succeeded" ? desktopText(locale, "showFiles") : desktopText(locale, "openReviewFolder"),
        () => api.revealTaskArtifacts(task.id),
        "quiet"
      ));
    }
    if (task.state === "awaiting-review" && task.stage === "roi-review") {
      actions.appendChild(actionButton(desktopText(locale, "importRoi"), async () => {
        const updated = await api.importConfirmedRoi(task.id);
        if (updated) {
          taskErrors.delete(task.id);
          tasks.set(updated.id, updated);
          renderTasks();
        }
      }));
    }
    if (task.state === "awaiting-review" && task.stage === "layout-review") {
      actions.appendChild(actionButton(desktopText(locale, "validateBuild"), async () => {
        const updated = await api.validateAndApplyLayout(task.id);
        taskErrors.delete(task.id);
        tasks.set(updated.id, updated);
        renderTasks();
      }));
    }
    if (task.state === "running" || task.state === "queued") {
      actions.appendChild(actionButton(desktopText(locale, "cancel"), async () => {
        await api.cancelTask(task.id);
      }, "quiet"));
    }
    if (managedTask && (task.state === "failed" || task.state === "cancelled")) {
      actions.appendChild(actionButton(desktopText(locale, "retry"), async () => {
        const updated = await api.resumeTask(task.id);
        taskErrors.delete(task.id);
        tasks.set(updated.id, updated);
        renderTasks();
      }));
    }
    if (managedTask && ["succeeded", "failed", "cancelled"].includes(task.state)) {
      actions.appendChild(actionButton(desktopText(locale, "removeRecord"), async () => {
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

function showPdfBytes(name: string, bytes: Uint8Array): void {
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  pdfUrl = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
  pdfLabel.textContent = name;
  selectedPdfName = name;
  pdfEmptyCopyKey = "previewEmpty";
  const frame = element("iframe", "p2md-desktop-pdf-frame");
  frame.title = `${desktopText(locale, "pdfPreview")}: ${name}`;
  frame.src = pdfUrl;
  pdfContent.replaceWith(frame);
  pdfContent = frame;
  setRightPaneMode("pdf");
}

function clearPdfPreview(copyKey: "previewEmpty" | "previewNoSource" | "previewLoadFailed"): void {
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = undefined;
  selectedPdfName = undefined;
  pdfEmptyCopyKey = copyKey;
  pdfLabel.textContent = desktopText(locale, "pdfPreview");
  const empty = element("div", "p2md-desktop-pdf-empty");
  empty.textContent = desktopText(locale, copyKey);
  pdfContent.replaceWith(empty);
  pdfContent = empty;
}

async function showPackagePdf(root: DesktopRootSelection): Promise<void> {
  if (!root.sourcePdf) {
    clearPdfPreview("previewNoSource");
    return;
  }
  try {
    const bytes = await api.readPackagePdf(root.id, root.sourcePdf.relativePath);
    showPdfBytes(root.sourcePdf.name, bytes);
  } catch {
    clearPdfPreview("previewLoadFailed");
  }
}

async function showPdf(pdf: DesktopPdfSelection): Promise<void> {
  showPdfBytes(pdf.name, await api.readPdf(pdf.id));
}

function addRequestError(message: string): void {
  const now = new Date().toISOString();
  const failed: ConversionTask = {
    id: `local-${Date.now()}`,
    pdfName: desktopText(locale, "workflowRequest"),
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
  setStartButtonsDisabled(true, desktopText(locale, "selecting"));
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
  setStartButtonsDisabled(true, desktopText(locale, "selecting"));
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
  startButtonsBusy = disabled;
  reviewedButton.disabled = disabled;
  processButton.disabled = disabled;
  const busyLabel = disabled ? desktopText(locale, "selecting") : undefined;
  reviewedButton.textContent = temporaryLabel ?? busyLabel ?? desktopText(locale, "startReviewed");
  processButton.textContent = temporaryLabel ?? busyLabel ?? desktopText(locale, "processDirect");
}

processButton.addEventListener("click", () => void startDirectConversion());
reviewedButton.addEventListener("click", () => void startReviewedLayout());
const stopTaskUpdates = api.onTaskUpdate((task) => {
  taskErrors.delete(task.id);
  tasks.set(task.id, task);
  renderTasks();
});
const stopDesktopLocale = subscribeReaderLocale((nextLocale) => applyDesktopLocale(nextLocale));
void api.listTasks().then((existing) => {
  existing.forEach((task) => tasks.set(task.id, task));
  renderTasks();
});
applyDesktopLocale(locale);
renderTasks();

window.addEventListener("beforeunload", () => {
  stopTaskUpdates();
  stopDesktopLocale();
  workspace.destroy();
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
}, { once: true });
