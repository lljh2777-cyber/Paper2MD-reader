import { describe, expect, it, vi } from "vitest";
import {
  loadMcpCommandClientOptions,
  ProcessingCommandClient
} from "../apps/processing-service/src/processing-command-client";

describe("processing command client", () => {
  it("posts only shared command envelopes to the configured loopback service", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:9123/api/v1/commands");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer local-token" });
      expect(JSON.parse(String(init?.body))).toEqual({ command: "get_service_status", input: {} });
      return Response.json({ command: "get_service_status", result: { status: "ok" } });
    });
    const client = new ProcessingCommandClient({
      serviceUrl: "http://127.0.0.1:9123/",
      serviceToken: "local-token",
      fetch: fetchMock
    });

    await expect(client.execute({ command: "get_service_status", input: {} })).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts only an exact loopback origin", () => {
    for (const url of [
      "https://127.0.0.1:8787/",
      "http://0.0.0.0:8787/",
      "http://example.org:8787/",
      "http://127.0.0.1:8787/api/",
      "http://user:secret@127.0.0.1:8787/"
    ]) {
      expect(() => new ProcessingCommandClient({ serviceUrl: url })).toThrow("PAPER2MD_MCP_SERVICE_URL");
    }
    expect(() => new ProcessingCommandClient({ serviceUrl: "http://[::1]:8787/" })).not.toThrow();
  });

  it("rejects service errors and mismatched response envelopes", async () => {
    const denied = new ProcessingCommandClient({
      fetch: async () => Response.json({ error: "Unauthorized" }, { status: 401 })
    });
    await expect(denied.execute({ command: "get_service_status", input: {} })).rejects.toThrow("Unauthorized");

    const mismatched = new ProcessingCommandClient({
      fetch: async () => Response.json({ command: "resolve_paper", result: {} })
    });
    await expect(mismatched.execute({ command: "get_service_status", input: {} })).rejects.toThrow("invalid command envelope");
  });

  it("loads bounded MCP sidecar configuration without exposing a remote endpoint", () => {
    expect(loadMcpCommandClientOptions({
      PAPER2MD_MCP_SERVICE_URL: "http://localhost:9000/",
      PAPER2MD_SERVICE_TOKEN: "secret",
      PAPER2MD_MCP_TIMEOUT_MS: "45000"
    })).toMatchObject({
      serviceUrl: "http://localhost:9000/",
      serviceToken: "secret",
      timeoutMilliseconds: 45_000
    });
    expect(() => loadMcpCommandClientOptions({ PAPER2MD_MCP_TIMEOUT_MS: "999" })).toThrow("timeout");
  });
});
