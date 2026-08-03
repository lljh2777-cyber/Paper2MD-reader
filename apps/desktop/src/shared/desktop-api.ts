export interface DesktopRootSelection {
  id: string;
  label: string;
}

export interface DesktopPdfSelection {
  id: string;
  name: string;
  size: number;
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
  choosePackage(): Promise<DesktopRootSelection | undefined>;
  choosePdf(): Promise<DesktopPdfSelection | undefined>;
  chooseOutputParent(): Promise<DesktopRootSelection | undefined>;
  fileExists(rootId: string, relativePath: string): Promise<boolean>;
  fileInfo(rootId: string, relativePath: string): Promise<{ size: number } | undefined>;
  readText(rootId: string, relativePath: string): Promise<string>;
  readBinary(rootId: string, relativePath: string): Promise<Uint8Array>;
  listFiles(rootId: string, relativeDirectory: string): Promise<string[]>;
  readPdf(pdfId: string): Promise<Uint8Array>;
  startConversion(request: StartConversionRequest): Promise<ConversionTask>;
  startReviewedLayout(request: StartReviewedLayoutRequest): Promise<ConversionTask>;
  importConfirmedRoi(taskId: string): Promise<ConversionTask | undefined>;
  revealTaskArtifacts(taskId: string): Promise<void>;
  validateAndApplyLayout(taskId: string): Promise<ConversionTask>;
  listTasks(): Promise<ConversionTask[]>;
  cancelTask(taskId: string): Promise<boolean>;
  onTaskUpdate(callback: (task: ConversionTask) => void): () => void;
}

export const DESKTOP_CHANNELS = {
  choosePackage: "paper2md:choose-package",
  choosePdf: "paper2md:choose-pdf",
  chooseOutputParent: "paper2md:choose-output-parent",
  fileExists: "paper2md:file-exists",
  fileInfo: "paper2md:file-info",
  readText: "paper2md:read-text",
  readBinary: "paper2md:read-binary",
  listFiles: "paper2md:list-files",
  readPdf: "paper2md:read-pdf",
  startConversion: "paper2md:start-conversion",
  startReviewedLayout: "paper2md:start-reviewed-layout",
  importConfirmedRoi: "paper2md:import-confirmed-roi",
  revealTaskArtifacts: "paper2md:reveal-task-artifacts",
  validateAndApplyLayout: "paper2md:validate-and-apply-layout",
  listTasks: "paper2md:list-tasks",
  cancelTask: "paper2md:cancel-task",
  taskUpdate: "paper2md:task-update"
} as const;
