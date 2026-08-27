import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { parseAgentCommand } from "../../../packages/agent-contracts/src/index";
import { AgentCommandHandler, AgentCommandNotImplementedError } from "./agent-command-handler";
import { isProcessingRequestOriginAllowed, loadProcessingServiceConfig, parseMineruOptions } from "./config";
import { JobManager } from "./job-manager";
import { IngestManager } from "./ingest-manager";
import { normalizePackagePath } from "./package-publisher";
import { PaperResolver } from "./paper-resolver";
import { PublishedPackageCatalog } from "./published-package-catalog";
import { publishClippingSubmission } from "./clipping-submission";
import { ClipperCredentialStore } from "./clipper-credentials";
import { VisualCorrectionManager } from "./visual-correction-manager";
import { createPaper2MdMcpHttpHandler } from "./mcp-http-handler";

const config = loadProcessingServiceConfig();
const jobs = new JobManager(config);
const resolver = new PaperResolver({
  contactEmail: config.contactEmail,
  timeoutMilliseconds: config.resolverTimeoutMilliseconds
});
const ingests = new IngestManager(config, resolver, {
  processPdf: async (bytes, filename) => {
    const task = await jobs.submitAcquiredPdf(filename, bytes, {
      model: "vlm",
      language: "en",
      timeoutSeconds: config.timeoutSeconds
    });
    const completed = await jobs.waitForTerminal(task.id, (config.timeoutSeconds + 120) * 1000);
    if (completed.state !== "succeeded" || !completed.package) throw new Error(completed.message || "MinerU extraction failed");
    return completed.package;
  }
});
const packages = new PublishedPackageCatalog(config.dataRoot, config.readerBaseUrl);
const visualCorrections = new VisualCorrectionManager(config.dataRoot, packages);
const agentCommands = new AgentCommandHandler(resolver, ingests, packages, visualCorrections, config.enableMcpHttp);
const mcpHttp = config.enableMcpHttp ? createPaper2MdMcpHttpHandler(agentCommands) : undefined;
const clipperCredentials = new ClipperCredentialStore(config.dataRoot);
const requestBuckets = new Map<string, { startedAt: number; count: number }>();

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer"
  });
  response.end(text);
}

function applyCors(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
  const origin = request.headers.origin;
  const clippingSubmission = pathname === "/api/v1/clippings";
  if (!isProcessingRequestOriginAllowed(config, pathname, origin)) {
    json(response, 403, { error: "Origin is not allowed" });
    return false;
  }
  if (!origin) return true;
  response.setHeader("Access-Control-Allow-Origin", origin);
  if (!clippingSubmission) response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  return true;
}

async function receiveMultipart(request: IncomingMessage): Promise<FormData> {
  const contentType = request.headers["content-type"]?.trim() ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new Error("Content-Type must be multipart/form-data with a boundary");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > config.maximumClippingBytes) {
    throw new Error(`Clipping body must be between 1 byte and ${config.maximumClippingBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > config.maximumClippingBytes) throw new Error("Clipping body exceeds the configured limit");
    chunks.push(bytes);
  }
  if (received !== declared) throw new Error("Clipping body length did not match Content-Length");
  return new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
}

function allowedHost(request: IncomingMessage): boolean {
  const host = request.headers.host?.trim().toLowerCase();
  return Boolean(host && config.allowedHosts.has(host));
}

function authorized(request: IncomingMessage): boolean {
  if (!config.serviceToken) return true;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const expectedHash = createHash("sha256").update(config.serviceToken).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function withinRateLimit(request: IncomingMessage): boolean {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60 * 60 * 1000) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 30;
}

async function pdfSignatureValid(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === 5 && signature.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

async function receivePdf(request: IncomingMessage, destination: string): Promise<number> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(contentLength) || contentLength < 5 || contentLength > config.maximumPdfBytes) {
    throw new Error(`PDF body must be between 5 bytes and ${config.maximumPdfBytes} bytes`);
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(received <= config.maximumPdfBytes ? undefined : new Error("PDF body exceeds the configured limit"), chunk);
    }
  });
  await pipeline(request, limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (received !== contentLength) throw new Error("PDF upload length did not match Content-Length");
  if (!await pdfSignatureValid(destination)) throw new Error("Uploaded content is not a PDF");
  return received;
}

async function receiveJson(request: IncomingMessage, maximumBytes = 16 * 1024): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared && (!Number.isSafeInteger(declared) || declared < 2 || declared > maximumBytes)) {
    throw new Error(`JSON body exceeds the ${maximumBytes}-byte limit`);
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maximumBytes) throw new Error(`JSON body exceeds the ${maximumBytes}-byte limit`);
    chunks.push(bytes);
  }
  if (!received) throw new Error("JSON body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function receiveBytes(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared && (!Number.isSafeInteger(declared) || declared < 1 || declared > maximumBytes)) throw new Error("Request body exceeds the safe size limit");
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maximumBytes) throw new Error("Request body exceeds the safe size limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function handleMcpHttp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!mcpHttp) return json(response, 404, { error: "Streamable HTTP MCP is disabled" });
  if (!withinRateLimit(request)) return json(response, 429, { error: "Too many MCP requests" });
  const headers = new Headers();
  Object.entries(request.headers).forEach(([name, value]) => {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  });
  const received = request.method === "POST" ? await receiveBytes(request, 1024 * 1024) : undefined;
  const body = received
    ? received.buffer.slice(received.byteOffset, received.byteOffset + received.byteLength) as ArrayBuffer
    : undefined;
  const webRequest = new Request(url, { method: request.method, headers, body });
  const result = await mcpHttp.fetch(webRequest);
  const responseHeaders: Record<string, string> = {};
  result.headers.forEach((value, name) => { responseHeaders[name] = value; });
  const bytes = new Uint8Array(await result.arrayBuffer());
  response.writeHead(result.status, { ...responseHeaders, "Content-Length": bytes.byteLength, "Cache-Control": "no-store" });
  response.end(bytes);
}

function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    pdf: "application/pdf"
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!allowedHost(request)) return json(response, 421, { error: "Host is not allowed" });
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (!applyCors(request, response, url.pathname)) return;
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Paper2MD-Filename, X-Paper2MD-Model, X-Paper2MD-Language",
      "Access-Control-Max-Age": "600"
    });
    response.end();
    return;
  }
  const origin = request.headers.origin ?? "";
  const clippingSubmission = url.pathname === "/api/v1/clippings";
  const pairingRedemption = url.pathname === "/api/v1/clipper/pairings/redeem";
  if (clippingSubmission) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    if (!await clipperCredentials.authorize(token, origin)) return json(response, 401, { error: "Clipper pairing is required" });
  } else if (!pairingRedemption && !authorized(request)) return json(response, 401, { error: "Unauthorized" });

  if (request.method === "POST" && url.pathname === "/api/v1/clipper/pairings") {
    return json(response, 201, clipperCredentials.createPairing());
  }
  if (request.method === "POST" && pairingRedemption) {
    try {
      const body = await receiveJson(request, 4 * 1024) as Record<string, unknown>;
      if (typeof body.pairing_id !== "string" || !/^[0-9a-f-]{36}$/.test(body.pairing_id)
        || typeof body.code !== "string" || !/^\d{8}$/.test(body.code)
        || Object.keys(body).some((key) => key !== "pairing_id" && key !== "code")) throw new Error("Invalid pairing request");
      return json(response, 201, await clipperCredentials.redeem(body.pairing_id, body.code, origin));
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "Pairing failed" });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/v1/clipper/credentials/revoke") {
    return json(response, 200, await clipperCredentials.revokeAll());
  }
  const visualSidecarMatch = /^\/api\/v1\/packages\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/sidecars\/visual-review$/.exec(url.pathname);
  if (request.method === "GET" && visualSidecarMatch) {
    try {
      return json(response, 200, await visualCorrections.readSidecar(visualSidecarMatch[1]));
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : "Visual review sidecar unavailable" });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return json(response, 200, await agentCommands.execute({ command: "get_service_status", input: {} }));
  }
  if ((request.method === "POST" || request.method === "GET" || request.method === "DELETE") && url.pathname === "/api/v1/mcp") {
    return handleMcpHttp(request, response, url);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/commands") {
    if (!withinRateLimit(request)) return json(response, 429, { error: "Too many agent command requests" });
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json(response, 415, { error: "Content-Type must be application/json" });
    }
    try {
      const command = parseAgentCommand(await receiveJson(request));
      const result = await agentCommands.execute(command);
      return json(response, 200, { command: command.command, result });
    } catch (error) {
      if (error instanceof AgentCommandNotImplementedError) return json(response, 501, { error: error.message });
      return json(response, 400, { error: error instanceof Error ? error.message : "Invalid agent command" });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/v1/jobs") {
    if (!withinRateLimit(request)) return json(response, 429, { error: "Too many PDF submissions" });
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf") {
      return json(response, 415, { error: "Content-Type must be application/pdf" });
    }
    let allocation: Awaited<ReturnType<JobManager["allocateUpload"]>> | undefined;
    try {
      const filename = String(request.headers["x-paper2md-filename"] || "paper.pdf");
      const options = parseMineruOptions(request.headers, config.timeoutSeconds);
      allocation = await jobs.allocateUpload(filename, options);
      await receivePdf(request, allocation.sourcePath);
      const task = jobs.enqueue(allocation.job.id);
      return json(response, 202, task);
    } catch (error) {
      if (allocation) {
        await unlink(allocation.sourcePath).catch(() => undefined);
        jobs.failUpload(allocation.job.id);
      }
      const message = error instanceof Error ? error.message : "PDF upload failed";
      return json(response, message.includes("queue") ? 429 : 400, { error: message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/v1/clippings") {
    if (!withinRateLimit(request)) return json(response, 429, { error: { code: "RATE_LIMITED", message: "Too many Clipper submissions" } });
    try {
      const result = await publishClippingSubmission(await receiveMultipart(request), config);
      return json(response, 201, result);
    } catch (error) {
      return json(response, 400, {
        error: {
          code: "PACKAGE_VALIDATION_FAILED",
          message: error instanceof Error ? error.message.slice(0, 1_024) : "Clipping submission failed validation",
          next_steps: ["Keep the current page open and retry", "Export a ZIP backup if the local service remains unavailable"]
        }
      });
    }
  }
  const jobMatch = /^\/api\/v1\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    return job ? json(response, 200, job) : json(response, 404, { error: "Job not found" });
  }
  const packageMatch = /^\/api\/v1\/packages\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(url.pathname);
  if (request.method === "GET" && packageMatch) {
    try {
      const packageDescriptor = await packages.descriptor(packageMatch[1]);
      return packageDescriptor ? json(response, 200, packageDescriptor) : json(response, 404, { error: "Package not found" });
    } catch {
      return json(response, 404, { error: "Package not found or failed validation" });
    }
  }
  const packageFileMatch = /^\/api\/v1\/packages\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/files\/(.+)$/.exec(url.pathname);
  if (request.method === "GET" && packageFileMatch) {
    try {
      const path = normalizePackagePath(packageFileMatch[2].split("/").map(decodeURIComponent).join("/"));
      const file = await packages.packageFilePath(packageFileMatch[1], path);
      if (!file) return json(response, 404, { error: "Package file not found" });
      const info = await stat(file);
      response.writeHead(200, {
        "Content-Type": contentType(path),
        "Content-Length": info.size,
        "Cache-Control": "private, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-site"
      });
      createReadStream(file).pipe(response);
      return;
    } catch {
      return json(response, 400, { error: "Invalid package path" });
    }
  }
  const fileMatch = /^\/api\/v1\/jobs\/([0-9a-f-]+)\/files\/(.+)$/.exec(url.pathname);
  if (request.method === "GET" && fileMatch) {
    try {
      const path = normalizePackagePath(fileMatch[2].split("/").map(decodeURIComponent).join("/"));
      const file = jobs.packageFilePath(fileMatch[1], path);
      if (!file) return json(response, 404, { error: "Package file not found" });
      const info = await stat(file);
      response.writeHead(200, {
        "Content-Type": contentType(path),
        "Content-Length": info.size,
        "Cache-Control": "private, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-site"
      });
      createReadStream(file).pipe(response);
      return;
    } catch {
      return json(response, 400, { error: "Invalid package path" });
    }
  }
  json(response, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error("Unhandled processing service error", error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.destroy();
  });
});

server.requestTimeout = (config.timeoutSeconds + 60) * 1000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, config.host, () => {
  console.log(`Paper2MD processing service listening on http://${config.host}:${config.port}`);
});
