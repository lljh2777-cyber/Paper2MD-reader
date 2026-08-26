export type ProcessingJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ProcessingStage = "extract" | "validate" | "publish" | "complete";

export interface PublishedPackageFile {
  path: string;
  size: number;
  sha256: string;
}

export interface PublishedPackageDescriptor {
  packageId: string;
  label: string;
  files: PublishedPackageFile[];
}

export interface ProcessingJob {
  id: string;
  filename: string;
  state: ProcessingJobState;
  stage: ProcessingStage;
  message: string;
  createdAt: string;
  updatedAt: string;
  package?: PublishedPackageDescriptor;
}

export interface MineruJobOptions {
  model: "vlm" | "pipeline";
  language: string;
  timeoutSeconds: number;
}
