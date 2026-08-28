import "../../../../styles.css";
import "../../../../local-reader/local-reader.css";
import "katex/dist/katex.min.css";
import "./desktop.css";
import { mountReaderWorkspace } from "../../../../packages/reader-ui/src/index";
import {
  ConversionTask,
  DesktopSelfCheck,
  DesktopLibrarySnapshot,
  DesktopPdfSelection,
  DesktopRootSelection,
  EvidenceLevel,
  ExtractionProfile,
  LayoutReviewMode,
  ReferencePolicy,
  MineruCredentialStatus
} from "../shared/desktop-api";
import { DesktopPackagePicker } from "./desktop-package-picker";
import { ElectronReaderFileSystem } from "./electron-reader-file-system";
import {
  getReaderLocale,
  readerText,
  ReaderLocale,
  subscribeReaderLocale
} from "../../../../src/ui/locale";
import {
  desktopText,
  localizedSelfCheck,
  localizedTaskMessage,
  localizedTaskStage,
  localizedTaskState
} from "./desktop-copy";
import { setReaderIcon } from "../../../../src/render/icons";
import { PdfVisualResolver } from "../../../../src/render/pdf-visual-resolver";

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
const appHeader = element("header", "p2md-desktop-app-header");
const appTitle = element("strong", "p2md-desktop-app-title");
appTitle.textContent = "Paper2MD";
appHeader.appendChild(appTitle);

const newExtractionButton = element("button", "p2md-desktop-new-button");
newExtractionButton.type = "button";
setReaderIcon(newExtractionButton, "plus");
const newExtractionLabel = element("span");
newExtractionLabel.textContent = "New extraction";
newExtractionButton.appendChild(newExtractionLabel);

type RailView = "library" | "tasks" | "favorites" | "settings";
const navigation = element("nav", "p2md-desktop-navigation");
navigation.ariaLabel = "Paper2MD";
const navButtons = new Map<RailView, HTMLButtonElement>();
function navigationButton(view: RailView, icon: string, label: string): HTMLButtonElement {
  const button = element("button", "p2md-desktop-nav-button");
  button.type = "button";
  button.dataset.view = view;
  setReaderIcon(button, icon);
  const text = element("span");
  text.textContent = label;
  button.appendChild(text);
  navButtons.set(view, button);
  navigation.appendChild(button);
  return button;
}
navigationButton("library", "library", "Library");
navigationButton("tasks", "tasks", "Tasks");
navigationButton("favorites", "star", "Favorites");
navigationButton("settings", "settings", "Settings");

const railContent = element("div", "p2md-desktop-rail-content");
const libraryPanel = element("section", "p2md-desktop-rail-panel p2md-desktop-library-panel");
const libraryHeader = element("div", "p2md-desktop-panel-header");
const libraryTitle = element("h2");
libraryTitle.textContent = "All documents";
const libraryCount = element("span", "p2md-desktop-library-count");
libraryHeader.append(libraryTitle, libraryCount);
const librarySearchLabel = element("label", "p2md-desktop-search");
setReaderIcon(librarySearchLabel, "search");
const librarySearch = element("input");
librarySearch.type = "search";
librarySearch.autocomplete = "off";
librarySearch.placeholder = "Search papers";
librarySearchLabel.appendChild(librarySearch);
const libraryMessage = element("p", "p2md-desktop-library-message");
const documentList = element("div", "p2md-desktop-document-list");
const libraryFooter = element("div", "p2md-desktop-library-footer");
const chooseLibraryButton = element("button", "p2md-desktop-quiet-button");
chooseLibraryButton.type = "button";
chooseLibraryButton.textContent = "Choose library";
const revealLibraryButton = element("button", "p2md-desktop-icon-action");
revealLibraryButton.type = "button";
revealLibraryButton.ariaLabel = "Show library in Explorer";
revealLibraryButton.title = revealLibraryButton.ariaLabel;
setReaderIcon(revealLibraryButton, "folder");
libraryFooter.append(chooseLibraryButton, revealLibraryButton);
libraryPanel.append(libraryHeader, librarySearchLabel, libraryMessage, documentList, libraryFooter);

const taskPanel = element("section", "p2md-desktop-rail-panel p2md-desktop-tasks-panel");
const taskHeader = element("header", "p2md-desktop-task-header");
const taskTitle = element("h1");
taskTitle.textContent = "Paper2MD tasks";
const taskCopy = element("p");
taskCopy.textContent = "Use your MinerU account for remote precision extraction, or run a local reviewed workflow.";

const readinessBanner = element("div", "p2md-desktop-readiness");
const readinessTitle = element("strong");
const readinessCopy = element("p");
const readinessAction = element("button", "p2md-desktop-quiet-button");
readinessAction.type = "button";
readinessBanner.append(readinessTitle, readinessCopy, readinessAction);

const mineruNotice = element("p", "p2md-desktop-privacy-notice");
mineruNotice.textContent = "Starting MinerU extraction uploads the selected PDF only after a separate confirmation.";
type ConversionPreset = "recommended" | "fast" | "scanned" | "custom";
const presetControl = optionSelect<ConversionPreset>("Conversion preset", [
  { value: "recommended", label: "Recommended for research papers" },
  { value: "fast", label: "Faster for simple digital PDFs" },
  { value: "scanned", label: "Scanned or Chinese PDFs" },
  { value: "custom", label: "Custom" }
]);
presetControl.wrapper.classList.add("p2md-desktop-preset");
const presetDescription = element("p", "p2md-desktop-preset-description");
const mineruOptions = element("div", "p2md-desktop-options p2md-desktop-mineru-options");
const mineruModelControl = optionSelect<"pipeline" | "vlm">("MinerU model", [
  { value: "pipeline", label: "Pipeline (standard documents)" },
  { value: "vlm", label: "VLM (complex layouts)" }
]);
const mineruLanguageControl = optionSelect<"en" | "ch">("Document language", [
  { value: "en", label: "English" },
  { value: "ch", label: "Chinese + English" }
]);
const mineruOcrControl = element("label", "p2md-desktop-check");
const mineruOcrInput = element("input");
mineruOcrInput.type = "checkbox";
const mineruOcrText = element("span");
mineruOcrText.textContent = "Enable OCR for scanned PDFs";
mineruOcrControl.append(mineruOcrInput, mineruOcrText);
mineruOptions.append(mineruModelControl.wrapper, mineruLanguageControl.wrapper, mineruOcrControl);
const remoteMineruButton = element("button", "p2md-desktop-process-button");
remoteMineruButton.type = "button";
remoteMineruButton.textContent = "Extract with MinerU";

const advancedOptions = element("details", "p2md-desktop-advanced");
const advancedSummary = element("summary");
advancedSummary.textContent = "Advanced settings";
const advancedRemoteTitle = element("h3");
advancedRemoteTitle.textContent = "MinerU details";

const optionsPanel = element("div", "p2md-desktop-options p2md-desktop-local-options");
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
const localTools = element("section", "p2md-desktop-local-tools");
const localToolsTitle = element("h3");
const localToolsCopy = element("p");
localTools.append(localToolsTitle, localToolsCopy, optionsPanel, reviewedButton, processButton);
advancedOptions.append(advancedSummary, advancedRemoteTitle, mineruOptions, localTools);
const taskList = element("div", "p2md-desktop-task-list");
taskHeader.append(
  taskTitle,
  taskCopy,
  readinessBanner,
  presetControl.wrapper,
  presetDescription,
  mineruNotice,
  remoteMineruButton,
  advancedOptions
);
taskPanel.append(taskHeader, taskList);

const settingsPanel = element("section", "p2md-desktop-rail-panel p2md-desktop-settings-panel");
const settingsHeading = element("h2", "p2md-desktop-settings-heading");
settingsHeading.textContent = "Settings";
const setupIntro = element("p", "p2md-desktop-setup-intro");
const setupSteps = element("ol", "p2md-desktop-setup-steps");
const setupLibraryStep = element("li");
const setupLibraryStepTitle = element("strong");
const setupLibraryStepCopy = element("span");
setupLibraryStep.append(setupLibraryStepTitle, setupLibraryStepCopy);
const setupTokenStep = element("li");
const setupTokenStepTitle = element("strong");
const setupTokenStepCopy = element("span");
setupTokenStep.append(setupTokenStepTitle, setupTokenStepCopy);
const setupConvertStep = element("li");
const setupConvertStepTitle = element("strong");
const setupConvertStepCopy = element("span");
setupConvertStep.append(setupConvertStepTitle, setupConvertStepCopy);
setupSteps.append(setupLibraryStep, setupTokenStep, setupConvertStep);
const librarySettings = element("section", "p2md-desktop-settings-section");
const librarySettingsTitle = element("h3");
librarySettingsTitle.textContent = "Local library";
const librarySettingsCopy = element("p");
const librarySettingsStatus = element("strong", "p2md-desktop-settings-status");
const librarySettingsActions = element("div", "p2md-desktop-settings-actions");
const settingsChooseLibraryButton = element("button", "p2md-desktop-task-action");
settingsChooseLibraryButton.type = "button";
const settingsRevealLibraryButton = element("button", "p2md-desktop-task-action");
settingsRevealLibraryButton.type = "button";
settingsRevealLibraryButton.dataset.tone = "quiet";
librarySettingsActions.append(settingsChooseLibraryButton, settingsRevealLibraryButton);
librarySettings.append(librarySettingsTitle, librarySettingsCopy, librarySettingsStatus, librarySettingsActions);

const mineruSettings = element("section", "p2md-desktop-settings-section");
const mineruSettingsTitle = element("h3");
mineruSettingsTitle.textContent = "MinerU API Token";
const mineruSettingsCopy = element("p");
const mineruRemoteNotice = element("p", "p2md-desktop-privacy-notice");
const mineruStatus = element("strong", "p2md-desktop-settings-status");
const createMineruTokenButton = element("button", "p2md-desktop-external-button");
createMineruTokenButton.type = "button";
setReaderIcon(createMineruTokenButton, "external");
const createMineruTokenLabel = element("span");
createMineruTokenButton.appendChild(createMineruTokenLabel);
const tokenInputLabel = element("label", "p2md-desktop-token-input");
setReaderIcon(tokenInputLabel, "key");
const tokenInput = element("input");
tokenInput.type = "password";
tokenInput.autocomplete = "new-password";
tokenInput.spellcheck = false;
tokenInput.ariaLabel = "MinerU API Token";
tokenInputLabel.appendChild(tokenInput);
const tokenActions = element("div", "p2md-desktop-settings-actions");
const saveTokenButton = element("button", "p2md-desktop-task-action");
saveTokenButton.type = "button";
const removeTokenButton = element("button", "p2md-desktop-task-action");
removeTokenButton.type = "button";
removeTokenButton.dataset.tone = "quiet";
tokenActions.append(saveTokenButton, removeTokenButton);
const settingsFeedback = element("p", "p2md-desktop-settings-feedback");
mineruSettings.append(
  mineruSettingsTitle,
  mineruSettingsCopy,
  mineruRemoteNotice,
  mineruStatus,
  createMineruTokenButton,
  tokenInputLabel,
  tokenActions,
  settingsFeedback
);
const selfCheckSection = element("section", "p2md-desktop-settings-section p2md-desktop-self-check");
const selfCheckHeader = element("div", "p2md-desktop-self-check-header");
const selfCheckTitle = element("h3");
const rerunSelfCheckButton = element("button", "p2md-desktop-quiet-button");
rerunSelfCheckButton.type = "button";
selfCheckHeader.append(selfCheckTitle, rerunSelfCheckButton);
const selfCheckList = element("ul", "p2md-desktop-self-check-list");
selfCheckSection.append(selfCheckHeader, selfCheckList);
settingsPanel.append(settingsHeading, setupIntro, setupSteps, librarySettings, mineruSettings, selfCheckSection);

railContent.append(libraryPanel, taskPanel, settingsPanel);
taskRail.append(appHeader, newExtractionButton, navigation, railContent);

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

const visualResolver = new PdfVisualResolver();
const workspace = mountReaderWorkspace(readerHost, {
  picker: new DesktopPackagePicker(api, async (selectedRoot) => {
    await showPackagePdf(selectedRoot);
    setRightPaneMode("visuals");
  }),
  visualResolver,
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
let currentRailView: RailView = "library";
let librarySnapshot: DesktopLibrarySnapshot = { configured: false, documents: [] };
let libraryBusy = true;
let libraryError: string | undefined;
let credentialStatus: MineruCredentialStatus = { configured: false, storage: "os-protected" };
let selfCheck: DesktopSelfCheck | undefined;
let selfCheckBusy = true;
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

function activateRailView(view: RailView): void {
  currentRailView = view;
  navButtons.forEach((button, name) => {
    const selected = name === view;
    button.dataset.selected = String(selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  libraryPanel.hidden = view !== "library" && view !== "favorites";
  taskPanel.hidden = view !== "tasks";
  settingsPanel.hidden = view !== "settings";
  renderDocuments();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDocumentDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", {
    year: "numeric", month: "short", day: "numeric"
  }).format(new Date(value));
}

function renderDocuments(): void {
  const favoritesOnly = currentRailView === "favorites";
  libraryTitle.textContent = desktopText(locale, favoritesOnly ? "favoriteDocuments" : "allDocuments");
  librarySearch.placeholder = desktopText(locale, "searchLibrary");
  chooseLibraryButton.textContent = desktopText(locale, librarySnapshot.configured ? "changeLibrary" : "chooseLibrary");
  revealLibraryButton.ariaLabel = desktopText(locale, "revealLibrary");
  revealLibraryButton.title = revealLibraryButton.ariaLabel;
  revealLibraryButton.disabled = !librarySnapshot.configured;
  documentList.replaceChildren();
  libraryMessage.hidden = false;
  libraryMessage.dataset.tone = libraryError ? "error" : "quiet";

  if (libraryBusy) {
    libraryCount.textContent = "";
    libraryMessage.textContent = desktopText(locale, "loadingLibrary");
    return;
  }
  if (libraryError) {
    libraryCount.textContent = "";
    libraryMessage.textContent = libraryError;
    return;
  }
  if (!librarySnapshot.configured) {
    libraryCount.textContent = "";
    libraryMessage.textContent = desktopText(locale, "noLibrary");
    return;
  }

  const query = librarySearch.value.trim().toLocaleLowerCase(locale === "zh-CN" ? "zh-CN" : "en");
  const documents = librarySnapshot.documents.filter((document) =>
    (!favoritesOnly || document.favorite) && (!query || document.label.toLocaleLowerCase().includes(query))
  );
  libraryCount.textContent = String(documents.length);
  if (!documents.length) {
    libraryMessage.textContent = query
      ? desktopText(locale, "noSearchResults")
      : desktopText(locale, favoritesOnly ? "emptyFavorites" : "emptyLibrary");
    return;
  }

  libraryMessage.hidden = true;
  documents.forEach((document) => {
    const row = element("article", "p2md-desktop-document");
    row.dataset.packageId = document.packageId;
    const open = element("button", "p2md-desktop-document-open");
    open.type = "button";
    open.title = `${desktopText(locale, "openDocument")}: ${document.label}`;
    const icon = element("span", "p2md-desktop-document-icon");
    setReaderIcon(icon, "document");
    const copy = element("span", "p2md-desktop-document-copy");
    const title = element("strong");
    title.textContent = document.label;
    const metadata = element("small");
    const parts = [
      desktopText(locale, document.kind === "mineru" ? "mineruDocument" : "clippingDocument"),
      formatDocumentDate(document.createdAt),
      formatBytes(document.totalSizeBytes),
      document.integrity === "legacy-size-bound" ? desktopText(locale, "legacyIntegrity") : undefined
    ].filter(Boolean);
    metadata.textContent = parts.join(" · ");
    copy.append(title, metadata);
    open.append(icon, copy);
    open.addEventListener("click", () => {
      open.disabled = true;
      libraryError = undefined;
      void api.openLibraryDocument(document.packageId).then(async (selected) => {
        await showPackagePdf(selected);
        await workspace.attachFileSystem(new ElectronReaderFileSystem(api, selected));
        setRightPaneMode("visuals");
      }).catch((error) => {
        libraryError = error instanceof Error ? error.message : "Could not open the selected paper";
        renderDocuments();
      }).finally(() => { open.disabled = false; });
    });
    const favorite = element("button", "p2md-desktop-favorite-button");
    favorite.type = "button";
    favorite.dataset.selected = String(document.favorite);
    favorite.ariaLabel = desktopText(locale, document.favorite ? "removeFavorite" : "addFavorite");
    favorite.title = favorite.ariaLabel;
    setReaderIcon(favorite, "star");
    favorite.addEventListener("click", () => {
      favorite.disabled = true;
      void api.setLibraryFavorite(document.packageId, !document.favorite).then((snapshot) => {
        librarySnapshot = snapshot;
        libraryError = undefined;
        renderDocuments();
      }).catch((error) => {
        libraryError = error instanceof Error ? error.message : "Could not update favorites";
        renderDocuments();
      }).finally(() => { favorite.disabled = false; });
    });
    row.append(open, favorite);
    documentList.appendChild(row);
  });
  if (librarySnapshot.truncated) {
    const note = element("p", "p2md-desktop-library-limit");
    note.textContent = desktopText(locale, "libraryTruncated");
    documentList.appendChild(note);
  }
}

async function chooseLibrary(): Promise<void> {
  chooseLibraryButton.disabled = true;
  settingsChooseLibraryButton.disabled = true;
  try {
    const snapshot = await api.chooseLibrary();
    if (snapshot) {
      librarySnapshot = snapshot;
      libraryError = undefined;
      libraryBusy = false;
      renderDocuments();
      renderSettings();
      void refreshSelfCheck();
    }
  } catch (error) {
    libraryError = error instanceof Error ? error.message : "Could not choose the Paper2MD library";
    renderDocuments();
  } finally {
    chooseLibraryButton.disabled = false;
    settingsChooseLibraryButton.disabled = false;
  }
}

async function revealLibrary(): Promise<void> {
  try {
    await api.revealLibrary();
  } catch (error) {
    libraryError = error instanceof Error ? error.message : "Could not reveal the Paper2MD library";
    renderDocuments();
  }
}

function renderSettings(): void {
  settingsHeading.textContent = desktopText(locale, "settings");
  setupIntro.textContent = desktopText(locale, "setupIntro");
  const setupConfigured = librarySnapshot.configured && credentialStatus.configured;
  setupLibraryStep.dataset.status = librarySnapshot.configured ? "ready" : "action-required";
  setupLibraryStepTitle.textContent = desktopText(locale, "setupLibraryTitle");
  setupLibraryStepCopy.textContent = `${desktopText(locale, "setupLibraryCopy")} · ${desktopText(
    locale, librarySnapshot.configured ? "setupComplete" : "setupRequired"
  )}`;
  setupTokenStep.dataset.status = credentialStatus.configured ? "ready" : "action-required";
  setupTokenStepTitle.textContent = desktopText(locale, "setupTokenTitle");
  setupTokenStepCopy.textContent = `${desktopText(locale, "setupTokenCopy")} · ${desktopText(
    locale, credentialStatus.configured ? "setupComplete" : "setupRequired"
  )}`;
  setupConvertStep.dataset.status = setupConfigured ? "ready" : "action-required";
  setupConvertStepTitle.textContent = desktopText(locale, "setupConvertTitle");
  setupConvertStepCopy.textContent = `${desktopText(locale, "setupConvertCopy")} · ${desktopText(
    locale, setupConfigured ? "setupComplete" : "setupRequired"
  )}`;
  librarySettingsTitle.textContent = desktopText(locale, "librarySettings");
  librarySettingsCopy.textContent = desktopText(locale, "librarySettingsCopy");
  librarySettingsStatus.textContent = librarySnapshot.configured
    ? librarySnapshot.label ?? desktopText(locale, "library")
    : desktopText(locale, "noLibrary");
  settingsChooseLibraryButton.textContent = desktopText(locale, librarySnapshot.configured ? "changeLibrary" : "chooseLibrary");
  settingsRevealLibraryButton.textContent = desktopText(locale, "revealLibrary");
  settingsRevealLibraryButton.disabled = !librarySnapshot.configured;
  mineruSettingsTitle.textContent = desktopText(locale, "mineruSettings");
  mineruSettingsCopy.textContent = desktopText(locale, "mineruSettingsCopy");
  mineruRemoteNotice.textContent = desktopText(locale, "mineruRemoteNotice");
  mineruStatus.textContent = credentialStatus.configured
    ? `${desktopText(locale, "tokenConfigured")} · ${credentialStatus.maskedToken ?? ""}`
    : desktopText(locale, "tokenNotConfigured");
  createMineruTokenLabel.textContent = desktopText(locale, "createMineruToken");
  tokenInput.placeholder = desktopText(locale, "tokenPlaceholder");
  saveTokenButton.textContent = desktopText(locale, "saveToken");
  removeTokenButton.textContent = desktopText(locale, "removeToken");
  removeTokenButton.disabled = !credentialStatus.configured;
  renderSelfCheck();
  renderConversionReadiness();
}

function renderSelfCheck(): void {
  selfCheckTitle.textContent = desktopText(locale, "selfCheck");
  rerunSelfCheckButton.textContent = desktopText(locale, selfCheckBusy ? "checkingSelfCheck" : "rerunSelfCheck");
  rerunSelfCheckButton.disabled = selfCheckBusy;
  selfCheckList.replaceChildren();
  if (!selfCheck) {
    const pending = element("li");
    pending.dataset.status = "checking";
    pending.textContent = desktopText(locale, "checkingSelfCheck");
    selfCheckList.appendChild(pending);
    return;
  }
  selfCheck.items.forEach((check) => {
    const row = element("li");
    row.dataset.status = check.status;
    const marker = element("span", "p2md-desktop-check-marker");
    marker.setAttribute("aria-hidden", "true");
    const label = element("span");
    label.textContent = localizedSelfCheck(check, locale);
    row.append(marker, label);
    selfCheckList.appendChild(row);
  });
}

function renderConversionReadiness(): void {
  const configured = librarySnapshot.configured && credentialStatus.configured;
  const warning = configured && selfCheck && !selfCheck.readyForMineru;
  readinessBanner.dataset.status = !configured ? "action-required" : warning ? "warning" : "ready";
  readinessTitle.textContent = desktopText(
    locale,
    !configured ? "readinessRequiredTitle" : warning ? "readinessWarningTitle" : "readinessReadyTitle"
  );
  readinessCopy.textContent = desktopText(
    locale,
    !configured ? "readinessRequiredCopy" : warning ? "readinessWarningCopy" : "readinessReadyCopy"
  );
  readinessAction.textContent = desktopText(locale, "openSetup");
  readinessAction.hidden = configured;
  localToolsTitle.textContent = desktopText(locale, "localTools");
  localToolsCopy.textContent = desktopText(
    locale,
    selfCheck?.localCliAvailable ? "localToolsReady" : "localToolsUnavailable"
  );
  setStartButtonsDisabled(startButtonsBusy);
}

async function refreshSelfCheck(): Promise<void> {
  selfCheckBusy = true;
  renderSelfCheck();
  try {
    selfCheck = await api.getSelfCheck();
  } catch {
    selfCheck = undefined;
  } finally {
    selfCheckBusy = false;
    renderSelfCheck();
    renderConversionReadiness();
  }
}

navButtons.forEach((button, view) => button.addEventListener("click", () => activateRailView(view)));
librarySearch.addEventListener("input", () => renderDocuments());
chooseLibraryButton.addEventListener("click", () => void chooseLibrary());
settingsChooseLibraryButton.addEventListener("click", () => void chooseLibrary());
revealLibraryButton.addEventListener("click", () => void revealLibrary());
settingsRevealLibraryButton.addEventListener("click", () => void revealLibrary());
createMineruTokenButton.addEventListener("click", () => void api.openMineruTokenPage());
readinessAction.addEventListener("click", () => activateRailView("settings"));
rerunSelfCheckButton.addEventListener("click", () => void refreshSelfCheck());
saveTokenButton.addEventListener("click", () => {
  const token = tokenInput.value;
  saveTokenButton.disabled = true;
  settingsFeedback.dataset.tone = "quiet";
  settingsFeedback.textContent = "";
  void api.saveMineruCredential(token).then((status) => {
    credentialStatus = status;
    tokenInput.value = "";
    settingsFeedback.textContent = desktopText(locale, "tokenSaved");
    renderSettings();
    void refreshSelfCheck();
  }).catch((error) => {
    settingsFeedback.dataset.tone = "error";
    settingsFeedback.textContent = error instanceof Error ? error.message : desktopText(locale, "settingsError");
  }).finally(() => { saveTokenButton.disabled = false; });
});
removeTokenButton.addEventListener("click", () => {
  removeTokenButton.disabled = true;
  settingsFeedback.dataset.tone = "quiet";
  void api.clearMineruCredential().then((status) => {
    credentialStatus = status;
    tokenInput.value = "";
    settingsFeedback.textContent = desktopText(locale, "tokenRemoved");
    renderSettings();
    void refreshSelfCheck();
  }).catch((error) => {
    settingsFeedback.dataset.tone = "error";
    settingsFeedback.textContent = error instanceof Error ? error.message : desktopText(locale, "settingsError");
  }).finally(() => { removeTokenButton.disabled = false; });
});

activateRailView(currentRailView);

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

function renderPreset(): void {
  const copyKey = {
    recommended: "presetRecommendedCopy",
    fast: "presetFastCopy",
    scanned: "presetScannedCopy",
    custom: "presetCustomCopy"
  }[presetControl.select.value as ConversionPreset] as
    | "presetRecommendedCopy"
    | "presetFastCopy"
    | "presetScannedCopy"
    | "presetCustomCopy";
  presetDescription.textContent = desktopText(locale, copyKey);
}

function applyConversionPreset(preset: ConversionPreset): void {
  presetControl.select.value = preset;
  if (preset === "recommended") {
    mineruModelControl.select.value = "vlm";
    mineruLanguageControl.select.value = "en";
    mineruOcrInput.checked = false;
  } else if (preset === "fast") {
    mineruModelControl.select.value = "pipeline";
    mineruLanguageControl.select.value = "en";
    mineruOcrInput.checked = false;
  } else if (preset === "scanned") {
    mineruModelControl.select.value = "vlm";
    mineruLanguageControl.select.value = "ch";
    mineruOcrInput.checked = true;
  }
  renderPreset();
}

function markPresetCustom(): void {
  presetControl.select.value = "custom";
  renderPreset();
}

function applyDesktopLocale(nextLocale: ReaderLocale): void {
  locale = nextLocale;
  document.title = readerText(locale, "desktopReaderTitle");
  appTitle.textContent = desktopText(locale, "appName");
  newExtractionLabel.textContent = desktopText(locale, "newExtraction");
  const navigationLabels: Record<RailView, string> = {
    library: desktopText(locale, "library"),
    tasks: desktopText(locale, "tasks"),
    favorites: desktopText(locale, "favorites"),
    settings: desktopText(locale, "settings")
  };
  navButtons.forEach((button, view) => {
    const label = button.querySelector("span");
    if (label) label.textContent = navigationLabels[view];
  });
  taskTitle.textContent = desktopText(locale, "conversionTitle");
  taskCopy.textContent = desktopText(locale, "conversionCopy");
  updateOptionControl(presetControl, desktopText(locale, "conversionPreset"), [
    desktopText(locale, "presetRecommended"),
    desktopText(locale, "presetFast"),
    desktopText(locale, "presetScanned"),
    desktopText(locale, "presetCustom")
  ]);
  renderPreset();
  mineruNotice.textContent = desktopText(locale, "remotePrivacy");
  advancedSummary.textContent = desktopText(locale, "advancedSettings");
  advancedRemoteTitle.textContent = desktopText(locale, "mineruDetails");
  updateOptionControl(mineruModelControl, desktopText(locale, "remoteModel"), [
    desktopText(locale, "pipelineModel"), desktopText(locale, "vlmModel")
  ]);
  updateOptionControl(mineruLanguageControl, desktopText(locale, "documentLanguage"), [
    desktopText(locale, "englishLanguage"), desktopText(locale, "chineseLanguage")
  ]);
  mineruOcrText.textContent = desktopText(locale, "enableOcr");
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
  renderDocuments();
  renderSettings();
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
      : task.workflow === "mineru-remote"
        ? `${desktopText(locale, "remoteConversion")} · ${localizedTaskStage(task, locale)}`
        : `${desktopText(locale, "directConversion")}${recoveryLabel}`;
    const state = element("span");
    state.textContent = `${localizedTaskState(task, locale)} · ${localizedTaskMessage(task, locale)}`;
    item.append(name, workflow, state);
    if (task.errorCode) {
      const errorCode = element("code", "p2md-desktop-task-error-code");
      errorCode.textContent = task.errorCode;
      item.appendChild(errorCode);
    }
    const actionError = taskErrors.get(task.id);
    if (actionError) {
      const error = element("span", "p2md-desktop-task-error");
      error.textContent = actionError;
      item.appendChild(error);
    }
    const actions = element("div", "p2md-desktop-task-actions");
    if (task.state === "succeeded" && (task.packageRootId || task.packageId)) {
      actions.appendChild(actionButton(desktopText(locale, "openResult"), async () => {
        const selected = task.packageId
          ? await api.openLibraryDocument(task.packageId)
          : { id: task.packageRootId!, label: task.outputName };
        await workspace.attachFileSystem(new ElectronReaderFileSystem(api, selected));
        await showPackagePdf(selected);
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
    if ((task.state === "running" || task.state === "queued")
      && !(task.workflow === "mineru-remote" && task.stage === "remote-publish")) {
      actions.appendChild(actionButton(desktopText(locale, "cancel"), async () => {
        await api.cancelTask(task.id);
      }, "quiet"));
    }
    if (managedTask && selfCheck?.localCliAvailable && task.workflow !== "mineru-remote"
      && (task.state === "failed" || task.state === "cancelled")) {
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

async function startRemoteMineru(): Promise<void> {
  if (!librarySnapshot.configured || !credentialStatus.configured) {
    activateRailView("settings");
    return;
  }
  setStartButtonsDisabled(true, desktopText(locale, "selecting"));
  try {
    const pdf = await api.choosePdf();
    if (!pdf) return;
    await showPdf(pdf);
    const task = await api.startRemoteMineru({
      pdfId: pdf.id,
      model: mineruModelControl.select.value as "pipeline" | "vlm",
      language: mineruLanguageControl.select.value as "en" | "ch",
      ocr: mineruOcrInput.checked
    });
    if (task) {
      tasks.set(task.id, task);
      renderTasks();
    }
  } catch (error) {
    addRequestError(error instanceof Error ? error.message : "Could not start MinerU extraction");
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
  reviewedButton.disabled = disabled || !selfCheck?.localCliAvailable;
  processButton.disabled = disabled || !selfCheck?.localCliAvailable;
  remoteMineruButton.disabled = disabled || !librarySnapshot.configured || !credentialStatus.configured;
  newExtractionButton.disabled = disabled;
  const busyLabel = disabled ? desktopText(locale, "selecting") : undefined;
  reviewedButton.textContent = temporaryLabel ?? busyLabel ?? desktopText(locale, "startReviewed");
  processButton.textContent = temporaryLabel ?? busyLabel ?? desktopText(locale, "processDirect");
  remoteMineruButton.textContent = temporaryLabel ?? busyLabel ?? desktopText(locale, "startRemote");
}

presetControl.select.addEventListener("change", () => applyConversionPreset(presetControl.select.value as ConversionPreset));
mineruModelControl.select.addEventListener("change", markPresetCustom);
mineruLanguageControl.select.addEventListener("change", markPresetCustom);
mineruOcrInput.addEventListener("change", markPresetCustom);
processButton.addEventListener("click", () => void startDirectConversion());
reviewedButton.addEventListener("click", () => void startReviewedLayout());
remoteMineruButton.addEventListener("click", () => void startRemoteMineru());
newExtractionButton.addEventListener("click", () => {
  if (!librarySnapshot.configured || !credentialStatus.configured) {
    activateRailView("settings");
  } else {
    activateRailView("tasks");
    void startRemoteMineru();
  }
});
const automaticallyOpenedPackages = new Set<string>();
const stopTaskUpdates = api.onTaskUpdate((task) => {
  taskErrors.delete(task.id);
  tasks.set(task.id, task);
  renderTasks();
  if (task.workflow === "mineru-remote" && task.state === "succeeded" && task.packageId
    && !automaticallyOpenedPackages.has(task.packageId)) {
    automaticallyOpenedPackages.add(task.packageId);
    void api.openLibraryDocument(task.packageId).then(async (selected) => {
      await workspace.attachFileSystem(new ElectronReaderFileSystem(api, selected));
      await showPackagePdf(selected);
      librarySnapshot = await api.getLibrarySnapshot();
      renderDocuments();
      renderSettings();
    }).catch((error) => {
      taskErrors.set(task.id, error instanceof Error ? error.message : "Could not open the published paper");
      renderTasks();
    });
  }
});
const stopDesktopLocale = subscribeReaderLocale((nextLocale) => applyDesktopLocale(nextLocale));
void api.listTasks().then((existing) => {
  existing.forEach((task) => tasks.set(task.id, task));
  renderTasks();
});
void Promise.all([
  api.getLibrarySnapshot(),
  api.getMineruCredentialStatus()
]).then(([snapshot, status]) => {
  librarySnapshot = snapshot;
  credentialStatus = status;
  libraryBusy = false;
  libraryError = undefined;
  renderDocuments();
  renderSettings();
  if (!snapshot.configured || !status.configured) activateRailView("settings");
  void refreshSelfCheck();
}).catch((error) => {
  libraryBusy = false;
  libraryError = error instanceof Error ? error.message : "Could not load desktop settings";
  renderDocuments();
  renderSettings();
});
applyDesktopLocale(locale);
applyConversionPreset("recommended");
renderTasks();

window.addEventListener("beforeunload", () => {
  stopTaskUpdates();
  stopDesktopLocale();
  workspace.destroy();
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
}, { once: true });
