import { resolve } from "node:path";

const LANGUAGE_VALUES = new Set([
  "ch", "ch_server", "en", "japan", "korean", "chinese_cht", "ta", "te", "ka", "el", "th",
  "latin", "arabic", "cyrillic", "east_slavic", "devanagari"
]);

export interface ProcessingServiceConfig {
  host: string;
  port: number;
  dataRoot: string;
  mineruCommand: string;
  pythonCommand?: string;
  mineruBaseUrl?: string;
  serviceToken?: string;
  allowedOrigins: Set<string>;
  maximumPdfBytes: number;
  maximumActiveJobs: number;
  timeoutSeconds: number;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid allowed origin: ${value}`);
  }
  return url.origin;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadProcessingServiceConfig(env: NodeJS.ProcessEnv = process.env): ProcessingServiceConfig {
  const host = env.PAPER2MD_SERVICE_HOST?.trim() || "127.0.0.1";
  const serviceToken = env.PAPER2MD_SERVICE_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(host) && !serviceToken) {
    throw new Error("PAPER2MD_SERVICE_TOKEN is required when the processing service binds beyond loopback");
  }
  const explicitOrigins = (env.PAPER2MD_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(validOrigin);
  const allowedOrigins = new Set(explicitOrigins.length ? explicitOrigins : [
    "http://127.0.0.1:4174",
    "http://localhost:4174"
  ]);
  const mineruBaseUrl = env.MINERU_BASE_URL?.trim() || undefined;
  if (mineruBaseUrl && !/^https?:\/\/[^\r\n]+$/.test(mineruBaseUrl)) {
    throw new Error("MINERU_BASE_URL must be one HTTP(S) URL");
  }
  return {
    host,
    port: integer(env.PAPER2MD_SERVICE_PORT, 8787, 1, 65535),
    dataRoot: resolve(env.PAPER2MD_DATA_ROOT?.trim() || "paper2md-service-data"),
    mineruCommand: env.MINERU_CLI_PATH?.trim() || "mineru-open-api",
    pythonCommand: env.PAPER2MD_PYTHON_PATH?.trim() || undefined,
    mineruBaseUrl,
    serviceToken,
    allowedOrigins,
    maximumPdfBytes: integer(env.PAPER2MD_MAX_PDF_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maximumActiveJobs: integer(env.PAPER2MD_MAX_ACTIVE_JOBS, 2, 1, 8),
    timeoutSeconds: integer(env.PAPER2MD_MINERU_TIMEOUT, 900, 60, 1800)
  };
}

export function parseMineruOptions(headers: Record<string, string | string[] | undefined>, timeoutSeconds: number) {
  const modelValue = String(headers["x-paper2md-model"] ?? "vlm");
  const language = String(headers["x-paper2md-language"] ?? "en");
  if (modelValue !== "vlm" && modelValue !== "pipeline") throw new Error("Unsupported MinerU model");
  if (!LANGUAGE_VALUES.has(language)) throw new Error("Unsupported MinerU language");
  return { model: modelValue, language, timeoutSeconds } as const;
}
