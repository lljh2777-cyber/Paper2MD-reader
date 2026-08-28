import { parentPort, workerData } from "node:worker_threads";
import { buildReaderContractsInProcess } from "./reader-contract-builder";

const channel = parentPort;
const data = workerData as { packageRoot?: unknown };

if (!channel) throw new Error("Reader contract worker requires a parent port");

void (async () => {
  try {
    if (typeof data.packageRoot !== "string" || !data.packageRoot) throw new Error("Reader contract worker received an invalid package root");
    const result = await buildReaderContractsInProcess({ packageRoot: data.packageRoot });
    channel.postMessage({ ok: true, result });
  } catch (error) {
    channel.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown reader contract error"
    });
  }
})();
