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
      "get_ingest_job",
      "list_packages",
      "read_package_manifest",
      "read_article_section",
      "list_figures",
      "get_visual_repair_candidates",
      "validate_visual_correction",
      "apply_visual_correction"
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
    expect(tools.find((tool) => tool.name === "read_article_section")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(tools.find((tool) => tool.name === "apply_visual_correction")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
  });

  it("routes package inspection tools through the same strict command boundary", async () => {
    const commands: AgentCommand[] = [];
    const client = await connectedClient(async (command) => {
      commands.push(command);
      return { accepted: true };
    });

    await client.callTool({
      name: "list_packages",
      arguments: { cursor: "package-001", limit: 10 }
    });
    await client.callTool({
      name: "read_article_section",
      arguments: { package_id: "package-002", heading_id: "heading-0003", start_line: 40, max_lines: 50 }
    });
    await client.callTool({ name: "list_figures", arguments: { package_id: "package-002" } });

    expect(commands).toEqual([
      { command: "list_packages", input: { cursor: "package-001", limit: 10 } },
      {
        command: "read_article_section",
        input: { package_id: "package-002", heading_id: "heading-0003", start_line: 40, max_lines: 50 }
      },
      { command: "list_figures", input: { package_id: "package-002" } }
    ]);
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
      name: "read_package_manifest",
      arguments: { package_id: "../outside", arbitrary_path: "C:/secrets" }
    })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({
      name: "resolve_paper",
      arguments: { query: "PMCID: PMC3531190", arbitrary_path: "C:/secrets" }
    })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({
      name: "apply_visual_correction",
      arguments: {
        package_id: "package-1", candidate_id: "candidate-1", validation_token: "token-1", confirm: false,
        correction: { kind: "full_page_visual", visual_block_id: "visual-1", member_block_ids: ["block-1", "block-2"] }
      }
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
