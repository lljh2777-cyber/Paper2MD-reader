import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPaper2MdMcpServer } from "./mcp-command-adapter";
import { loadMcpCommandClientOptions, ProcessingCommandClient } from "./processing-command-client";

const client = new ProcessingCommandClient(loadMcpCommandClientOptions());
const handle = serveStdio(() => createPaper2MdMcpServer(client), {
  onerror: (error) => console.error("Paper2MD MCP transport error", error)
});

process.on("SIGINT", () => {
  void handle.close();
});

process.on("SIGTERM", () => {
  void handle.close();
});

console.error("Paper2MD MCP server listening on stdio");
