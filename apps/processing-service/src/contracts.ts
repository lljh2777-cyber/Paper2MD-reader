export type {
  ProcessingJobState,
  ProcessingStage,
  PublishedPackageFile,
  PublishedPackageDescriptor,
  ProcessingJob
} from "../../../packages/agent-contracts/src/index";

export interface MineruJobOptions {
  model: "vlm" | "pipeline";
  language: string;
  timeoutSeconds: number;
}
