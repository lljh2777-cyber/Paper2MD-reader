export interface DesktopRootSelection {
  id: string;
  label: string;
  sourcePdf?: DesktopPackagePdf;
}

export interface DesktopPackagePdf {
  relativePath: string;
  name: string;
  size: number;
}

export interface DesktopPdfSelection {
  id: string;
  name: string;
  size: number;
}

export interface DesktopLibraryDocument {
  packageId: string;
  label: string;
  kind: "mineru" | "clipping";
  integrity: "hash-bound" | "legacy-size-bound";
  createdAt?: string;
  fileCount: number;
  totalSizeBytes: number;
  favorite: boolean;
}

export interface DesktopLibrarySnapshot {
  configured: boolean;
  label?: string;
  documents: DesktopLibraryDocument[];
  truncated?: boolean;
}

export interface MineruCredentialStatus {
  configured: boolean;
  storage: "os-protected";
  maskedToken?: string;
}

export type ConversionTaskState = "queued" | "running" | "awaiting-review" | "succeeded" | "failed" | "cancelled";
export type ConversionWorkflow = "direct" | "reviewed-layout";
export type ConversionStage =
  | "direct-convert"
  | "roi-proposal"
  | "roi-review"
  | "layout-prepare"
  | "layout-review"
  | "layout-validation"
  | "layout-apply"
  | "complete";

export interface ConversionTask {
  id: string;
  pdfName: string;
  outputName: string;
  workflow: ConversionWorkflow;
  stage: ConversionStage;
  state: ConversionTaskState;
  createdAt: string;
  updatedAt: string;
  message: string;
  packageRootId?: string;
  artifactRootId?: string;
  artifactLabel?: string;
  recovered?: boolean;
}

export interface StartConversionRequest {
  pdfId: string;
  outputParentId: string;
  backend: "pdfium";
  regionRenderMode: "off" | "auto";
}

export type ExtractionProfile = "fast" | "standard" | "forensic";
export type LayoutReviewMode = "visual-direct" | "candidate-assisted";
export type ReferencePolicy = "keep" | "omit" | "separate";
export type EvidenceLevel = "minimal" | "standard" | "full";

export interface StartReviewedLayoutRequest {
  pdfId: string;
  outputParentId: string;
  backend: "pdfium";
  extractionProfile: ExtractionProfile;
  reviewMode: LayoutReviewMode;
  references: ReferencePolicy;
  evidence: EvidenceLevel;
  includeSourcePdf: boolean;
}

export interface Paper2MDDesktopApi {
  getLibrarySnapshot(): Promise<DesktopLibrarySnapshot>;
  chooseLibrary(): Promise<DesktopLibrarySnapshot | undefined>;
  openLibraryDocument(packageId: string): Promise<DesktopRootSelection>;
  setLibraryFavorite(packageId: string, favorite: boolean): Promise<DesktopLibrarySnapshot>;
  revealLibrary(): Promise<void>;
  getMineruCredentialStatus(): Promise<MineruCredentialStatus>;
  saveMineruCredential(token: string): Promise<MineruCredentialStatus>;
  clearMineruCredential(): Promise<MineruCredentialStatus>;
  openMineruTokenPage(): Promise<void>;
  choosePackage(): Promise<DesktopRootSelection | undefined>;
  choosePdf(): Promise<DesktopPdfSelection | undefined>;
  chooseOutputParent(): Promise<DesktopRootSelection | undefined>;
  fileExists(rootId: string, relativePath: string): Promise<boolean>;
  fileInfo(rootId: string, relativePath: string): Promise<{ size: number } | undefined>;
  readText(rootId: string, relativePath: string): Promise<string>;
  readBinary(rootId: string, relativePath: string): Promise<Uint8Array>;
  listFiles(rootId: string, relativeDirectory: string): Promise<string[]>;
  readPackagePdf(rootId: string, relativePath: string): Promise<Uint8Array>;
  readPdf(pdfId: string): Promise<Uint8Array>;
  startConversion(request: StartConversionRequest): Promise<ConversionTask>;
  startReviewedLayout(request: StartReviewedLayoutRequest): Promise<ConversionTask>;
  importConfirmedRoi(taskId: string): Promise<ConversionTask | undefined>;
  revealTaskArtifacts(taskId: string): Promise<void>;
  validateAndApplyLayout(taskId: string): Promise<ConversionTask>;
  listTasks(): Promise<ConversionTask[]>;
  cancelTask(taskId: string): Promise<boolean>;
  removeTask(taskId: string): Promise<boolean>;
  resumeTask(taskId: string): Promise<ConversionTask>;
  onTaskUpdate(callback: (task: ConversionTask) => void): () => void;
}

export const DESKTOP_CHANNELS = {
  getLibrarySnapshot: "paper2md:get-library-snapshot",
  chooseLibrary: "paper2md:choose-library",
  openLibraryDocument: "paper2md:open-library-document",
  setLibraryFavorite: "paper2md:set-library-favorite",
  revealLibrary: "paper2md:reveal-library",
  getMineruCredentialStatus: "paper2md:get-mineru-credential-status",
  saveMineruCredential: "paper2md:save-mineru-credential",
  clearMineruCredential: "paper2md:clear-mineru-credential",
  openMineruTokenPage: "paper2md:open-mineru-token-page",
  choosePackage: "paper2md:choose-package",
  choosePdf: "paper2md:choose-pdf",
  chooseOutputParent: "paper2md:choose-output-parent",
  fileExists: "paper2md:file-exists",
  fileInfo: "paper2md:file-info",
  readText: "paper2md:read-text",
  readBinary: "paper2md:read-binary",
  listFiles: "paper2md:list-files",
  readPackagePdf: "paper2md:read-package-pdf",
  readPdf: "paper2md:read-pdf",
  startConversion: "paper2md:start-conversion",
  startReviewedLayout: "paper2md:start-reviewed-layout",
  importConfirmedRoi: "paper2md:import-confirmed-roi",
  revealTaskArtifacts: "paper2md:reveal-task-artifacts",
  validateAndApplyLayout: "paper2md:validate-and-apply-layout",
  listTasks: "paper2md:list-tasks",
  cancelTask: "paper2md:cancel-task",
  removeTask: "paper2md:remove-task",
  resumeTask: "paper2md:resume-task",
  taskUpdate: "paper2md:task-update"
} as const;
