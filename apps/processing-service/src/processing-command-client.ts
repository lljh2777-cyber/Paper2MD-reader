import type { AgentCommand } from "../../../packages/agent-contracts/src/index";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787/";
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface AgentCommandExecutor {
  execute(command: AgentCommand): Promise<unknown>;
}

export interface ProcessingCommandClientOptions {
  serviceUrl?: string;
  serviceToken?: string;
  timeoutMilliseconds?: number;
  fetch?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validatedLocalServiceUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    throw new Error("PAPER2MD_MCP_SERVICE_URL must be a loopback HTTP URL");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PAPER2MD_MCP_SERVICE_URL must be an origin without credentials, path, query, or fragment");
  }
  return url;
}

function validatedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error("MCP command timeout must be an integer between 1000 and 120000 milliseconds");
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAXIMUM_RESPONSE_BYTES) throw new Error("Processing service response exceeds the safe size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Processing service response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel("Processing service response exceeds the safe size limit");
        throw new Error("Processing service response exceeds the safe size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function loadMcpCommandClientOptions(env: NodeJS.ProcessEnv = process.env): ProcessingCommandClientOptions {
  const timeoutValue = env.PAPER2MD_MCP_TIMEOUT_MS?.trim();
  return {
    serviceUrl: env.PAPER2MD_MCP_SERVICE_URL?.trim() || DEFAULT_SERVICE_URL,
    serviceToken: env.PAPER2MD_SERVICE_TOKEN?.trim() || undefined,
    timeoutMilliseconds: validatedTimeout(timeoutValue ? Number(timeoutValue) : DEFAULT_TIMEOUT_MILLISECONDS)
  };
}

export class ProcessingCommandClient implements AgentCommandExecutor {
  private readonly serviceUrl: URL;
  private readonly serviceToken?: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ProcessingCommandClientOptions = {}) {
    this.serviceUrl = validatedLocalServiceUrl(options.serviceUrl ?? DEFAULT_SERVICE_URL);
    this.serviceToken = options.serviceToken?.trim() || undefined;
    this.timeoutMilliseconds = validatedTimeout(options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async execute(command: AgentCommand): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json"
      };
      if (this.serviceToken) headers.Authorization = `Bearer ${this.serviceToken}`;
      const response = await this.fetchImplementation(new URL("api/v1/commands", this.serviceUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(command),
        redirect: "error",
        signal: controller.signal
      });
      const payload = object(await boundedJson(response));
      if (!payload) throw new Error("Processing service returned an invalid JSON object");
      if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : `Processing service returned HTTP ${response.status}`;
        throw new Error(message.slice(0, 1_024));
      }
      if (payload.command !== command.command || !("result" in payload)) {
        throw new Error("Processing service returned an invalid command envelope");
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
