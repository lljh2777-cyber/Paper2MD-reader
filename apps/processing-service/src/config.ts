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
  mineruBaseUrl?: string;
  serviceToken?: string;
  allowedOrigins: Set<string>;
  allowedClipperOrigins: Set<string>;
  allowedHosts: Set<string>;
  contactEmail?: string;
  resolverTimeoutMilliseconds: number;
  readerBaseUrl: string;
  maximumPdfBytes: number;
  maximumClippingBytes: number;
  maximumActiveJobs: number;
  timeoutSeconds: number;
  enableMcpHttp: boolean;
}

const LOCAL_CLIPPER_EXTENSION_ID = "fkngpgapepiflkncpicajbmgafebgbip";

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

function validClipperId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Invalid Clipper extension ID: ${value}`);
  return id;
}

function validHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 255 || /[\s/@\\]/.test(normalized)) {
    throw new Error(`Invalid allowed host: ${value}`);
  }
  const url = new URL(`http://${normalized}`);
  if (url.pathname !== "/" || url.search || url.hash || url.host !== normalized) {
    throw new Error(`Invalid allowed host: ${value}`);
  }
  return normalized;
}

function validEmail(value: string | undefined): string | undefined {
  const email = value?.trim();
  if (!email) return undefined;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("PAPER2MD_CONTACT_EMAIL must be a valid contact email");
  }
  return email;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function boolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || !value.trim()) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error("Expected a boolean configuration value");
}

function validReaderBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PAPER2MD_READER_BASE_URL must use HTTPS, except on loopback");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("PAPER2MD_READER_BASE_URL must not contain credentials, query, or fragment");
  return url.href;
}

export function loadProcessingServiceConfig(env: NodeJS.ProcessEnv = process.env): ProcessingServiceConfig {
  const host = env.PAPER2MD_SERVICE_HOST?.trim() || "127.0.0.1";
  const port = integer(env.PAPER2MD_SERVICE_PORT, 8787, 1, 65535);
  const serviceToken = env.PAPER2MD_SERVICE_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(host) && !serviceToken) {
    throw new Error("PAPER2MD_SERVICE_TOKEN is required when the processing service binds beyond loopback");
  }
  const enableMcpHttp = boolean(env.PAPER2MD_ENABLE_MCP_HTTP);
  if (enableMcpHttp && !isLoopbackHost(host)) {
    throw new Error("Streamable HTTP MCP is limited to loopback until an OAuth tenant gateway is configured");
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
  const configuredClipperIds = (env.PAPER2MD_ALLOWED_CLIPPER_IDS ?? LOCAL_CLIPPER_EXTENSION_ID)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(validClipperId);
  const allowedClipperOrigins = new Set(configuredClipperIds.map((id) => `chrome-extension://${id}`));
  const explicitHosts = (env.PAPER2MD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(validHost);
  const hostWithPort = (value: string) => port === 80 ? value : `${value}:${port}`;
  const defaultHosts = isLoopbackHost(host)
    ? [hostWithPort("127.0.0.1"), hostWithPort("localhost"), hostWithPort("[::1]")]
    : [hostWithPort(host)];
  const mineruBaseUrl = env.MINERU_BASE_URL?.trim() || undefined;
  if (mineruBaseUrl && !/^https?:\/\/[^\r\n]+$/.test(mineruBaseUrl)) {
    throw new Error("MINERU_BASE_URL must be one HTTP(S) URL");
  }
  return {
    host,
    port,
    dataRoot: resolve(env.PAPER2MD_DATA_ROOT?.trim() || "paper2md-service-data"),
    mineruCommand: env.MINERU_CLI_PATH?.trim() || "mineru-open-api",
    mineruBaseUrl,
    serviceToken,
    allowedOrigins,
    allowedClipperOrigins,
    allowedHosts: new Set(explicitHosts.length ? explicitHosts : defaultHosts.map(validHost)),
    contactEmail: validEmail(env.PAPER2MD_CONTACT_EMAIL),
    resolverTimeoutMilliseconds: integer(env.PAPER2MD_RESOLVER_TIMEOUT_MS, 12_000, 1_000, 60_000),
    readerBaseUrl: validReaderBaseUrl(env.PAPER2MD_READER_BASE_URL?.trim() || "http://127.0.0.1:4174/"),
    maximumPdfBytes: integer(env.PAPER2MD_MAX_PDF_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maximumClippingBytes: integer(env.PAPER2MD_MAX_CLIPPING_BYTES, 84 * 1024 * 1024, 1024, 192 * 1024 * 1024),
    maximumActiveJobs: integer(env.PAPER2MD_MAX_ACTIVE_JOBS, 2, 1, 8),
    timeoutSeconds: integer(env.PAPER2MD_MINERU_TIMEOUT, 900, 60, 1800),
    enableMcpHttp
  };
}

export function isProcessingRequestOriginAllowed(
  config: Pick<ProcessingServiceConfig, "allowedOrigins" | "allowedClipperOrigins">,
  pathname: string,
  origin: string | undefined
): boolean {
  if (pathname === "/api/v1/clippings" || pathname === "/api/v1/clipper/pairings/redeem") {
    return Boolean(origin && config.allowedClipperOrigins.has(origin));
  }
  return !origin || config.allowedOrigins.has(origin);
}

export function parseMineruOptions(headers: Record<string, string | string[] | undefined>, timeoutSeconds: number) {
  const modelValue = String(headers["x-paper2md-model"] ?? "vlm");
  const language = String(headers["x-paper2md-language"] ?? "en");
  if (modelValue !== "vlm" && modelValue !== "pipeline") throw new Error("Unsupported MinerU model");
  if (!LANGUAGE_VALUES.has(language)) throw new Error("Unsupported MinerU language");
  return { model: modelValue, language, timeoutSeconds } as const;
}
