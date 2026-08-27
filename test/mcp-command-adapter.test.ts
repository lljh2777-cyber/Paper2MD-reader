import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommand } from "../packages/agent-contracts/src/index";
import { createPaper2MdMcpServer } from "../apps/processing-service/src/mcp-command-adapter";

describe("Paper2MD MCP command adapter", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closeCallbacks.length) await closeCallbacks.pop()?.();
  });

  async function connectedClient(execute: (command: AgentCommand) => Promise<unknown>) {
    const server = createPaper2MdMcpServer({ execute });
    const client = new Client({ name: "paper2md-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("registers only the implemented narrow tools with accurate effect hints", async () => {
    const client = await connectedClient(async () => ({ status: "ok" }));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_service_status",
      "resolve_paper",
      "ingest_paper",
      "get_ingest_job"
    ]);
    expect(tools.find((tool) => tool.name === "get_service_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(tools.find((tool) => tool.name === "ingest_paper")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
  });

  it("routes validated inputs through the shared AgentCommand envelope", async () => {
    const commands: AgentCommand[] = [];
    const client = await connectedClient(async (command) => {
      commands.push(command);
      return command.command === "get_ingest_job"
        ? { job_id: command.input.job_id, state: "ready" }
        : { accepted: true };
    });

    const result = await client.callTool({
      name: "get_ingest_job",
      arguments: { job_id: "job-123" }
    });

    expect(commands).toEqual([{ command: "get_ingest_job", input: { job_id: "job-123" } }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ job_id: "job-123", state: "ready" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  });

  it("fails closed for unsupported fields and unsafe identifiers", async () => {
    const client = await connectedClient(async () => ({ status: "ok" }));

    await expect(client.callTool({
      name: "get_ingest_job",
      arguments: { job_id: "../outside" }
    })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({
      name: "resolve_paper",
      arguments: { query: "PMCID: PMC3531190", arbitrary_path: "C:/secrets" }
    })).resolves.toMatchObject({ isError: true });
  });

  it("returns bounded MCP tool errors without leaking exceptions onto stdout", async () => {
    const client = await connectedClient(async () => {
      throw new Error(`Provider failed ${"x".repeat(2_000)}`);
    });

    const result = await client.callTool({ name: "resolve_paper", arguments: { query: "PMID: 23193287" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0]?.type === "text" && result.content[0].text.length).toBe(1_024);
  });
});
