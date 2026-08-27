import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ReaderContractSummary {
  viewer: Record<string, unknown>;
  repair: Record<string, unknown>;
  candidates: Record<string, unknown>;
}

function pythonCommand(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return process.platform === "win32" ? "python" : "python3";
}

function parseSummary(stdout: string): ReaderContractSummary {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? "") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Reader contract builder returned an invalid summary");
  }
  const value = parsed as Record<string, unknown>;
  const asRecord = (item: unknown): Record<string, unknown> =>
    item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
  return {
    viewer: asRecord(value.viewer),
    repair: asRecord(value.repair),
    candidates: asRecord(value.candidates)
  };
}

export async function buildReaderContracts(input: {
  packageRoot: string;
  timeoutSeconds: number;
  pythonCommand?: string;
  scriptPath: string;
}): Promise<ReaderContractSummary> {
  const python = pythonCommand(input.pythonCommand);
  const script = input.scriptPath;
  return await new Promise<ReaderContractSummary>((resolvePromise, reject) => {
    const child = spawn(python, [script, "--package-root", input.packageRoot], {
      cwd: input.packageRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(10, input.timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      else child.kill();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Reader contract builder could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("Reader contract builder timed out"));
        return;
      }
      if (outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error("Reader contract builder exceeded its output limit"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Reader contract builder failed (${code ?? "unknown"}): ${stderr.trim() || "no details"}`));
        return;
      }
      try {
        resolvePromise(parseSummary(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}
