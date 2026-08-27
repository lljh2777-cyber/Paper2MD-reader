import { createMcpHandler } from "@modelcontextprotocol/server";
import { createPaper2MdMcpServer, type AgentCommandExecutor } from "./mcp-command-adapter";

/** Stateless local Streamable HTTP: one MCP server instance per request, no shared client session state. */
export function createPaper2MdMcpHttpHandler(executor: AgentCommandExecutor) {
  return createMcpHandler(
    () => createPaper2MdMcpServer(executor),
    {
      legacy: "stateless",
      responseMode: "json",
      maxSubscriptions: 0,
      keepAliveMs: 0,
      onerror: (error) => console.error("Paper2MD Streamable HTTP MCP error", error)
    }
  );
}
