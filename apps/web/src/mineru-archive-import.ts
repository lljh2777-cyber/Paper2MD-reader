import type { MinerUArchiveInspection } from "../../../src/model/mineru-archive";
import { MINERU_ARCHIVE_READER_LIMITS } from "../../../src/model/mineru-archive";

const WORKER_TIMEOUT_MILLISECONDS = 60_000;

interface WorkerSuccess {
  ok: true;
  extraction: MinerUArchiveInspection & {
    rootPrefix: string;
    articlePath: string;
    contentListPath: string;
  };
  files: Array<{ path: string; data: ArrayBuffer }>;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

export interface BrowserMinerUArchiveImport extends MinerUArchiveInspection {
  sourceArchive: File;
  files: ReadonlyMap<string, File>;
  rootPrefix: string;
  articlePath: string;
  contentListPath: string;
}

function archiveLabel(filename: string): string {
  const label = filename.replace(/(?:\.mineru)?\.zip$/i, "").trim();
  return label || "MinerU result";
}

function mimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (/\.png$/i.test(lower)) return "image/png";
  if (/\.jpe?g$/i.test(lower)) return "image/jpeg";
  if (/\.webp$/i.test(lower)) return "image/webp";
  if (/\.gif$/i.test(lower)) return "image/gif";
  if (/\.bmp$/i.test(lower)) return "image/bmp";
  return "application/octet-stream";
}

export function mineruArchiveRootLabel(filename: string): string {
  return archiveLabel(filename);
}

export async function importMinerUArchiveFile(
  sourceArchive: File,
  signal?: AbortSignal
): Promise<BrowserMinerUArchiveImport> {
  if (!/(?:\.mineru)?\.zip$/i.test(sourceArchive.name)) throw new Error("请选择一个 MinerU ZIP 文件。");
  if (sourceArchive.size < 22 || sourceArchive.size > MINERU_ARCHIVE_READER_LIMITS.archiveBytes) {
    throw new Error("网页 Reader 当前只接受不超过 64MB 的 MinerU ZIP。");
  }
  if (signal?.aborted) throw new Error("MinerU ZIP 导入已取消。");
  const archive = await sourceArchive.arrayBuffer();
  if (signal?.aborted) throw new Error("MinerU ZIP 导入已取消。");
  const worker = new Worker(new URL("./mineru-archive-worker.ts", import.meta.url), { type: "module" });
  return await new Promise<BrowserMinerUArchiveImport>((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error("MinerU ZIP 导入已取消。")));
    timeout = window.setTimeout(() => {
      finish(() => reject(new Error("MinerU ZIP 校验超时；原始文件未被修改。")));
    }, WORKER_TIMEOUT_MILLISECONDS);
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", () => {
      finish(() => reject(new Error("MinerU ZIP 校验 Worker 未能启动。")));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<WorkerSuccess | WorkerFailure>) => {
      const message = event.data;
      if (!message?.ok) {
        finish(() => reject(new Error(message?.error || "MinerU ZIP 校验失败。")));
        return;
      }
      const files = new Map<string, File>();
      for (const entry of message.files) {
        files.set(entry.path, new File([entry.data], entry.path.split("/").pop() ?? entry.path, {
          type: mimeType(entry.path)
        }));
      }
      finish(() => resolve({
        sourceArchive,
        files,
        ...message.extraction
      }));
    }, { once: true });
    worker.postMessage({ archive }, [archive]);
  });
}
