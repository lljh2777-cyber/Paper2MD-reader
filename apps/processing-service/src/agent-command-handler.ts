import type { AgentCommand } from "../../../packages/agent-contracts/src/index";
import { PaperResolver } from "./paper-resolver";
import { IngestManager } from "./ingest-manager";

export class AgentCommandNotImplementedError extends Error {}

export class AgentCommandHandler {
  constructor(private readonly resolver: PaperResolver, private readonly ingests: IngestManager) {}

  async execute(command: AgentCommand): Promise<unknown> {
    switch (command.command) {
      case "get_service_status":
        return {
          status: "ok",
          extraction: "mineru-precision",
          formats: ["md", "json"],
          resolver_query_kinds: ["pmid", "pmcid", "doi"],
          ingest_query_kinds: ["pmid", "pmcid", "doi"],
          automatic_ingest_sources: ["pmc-open-html"],
          agent_transport: "http-command",
          available_agent_transports: ["http-command", "mcp-stdio-sidecar"]
        };
      case "resolve_paper":
        return this.resolver.resolve(command.input.query);
      case "ingest_paper":
        return this.ingests.create(command.input.query);
      case "get_ingest_job": {
        const job = this.ingests.get(command.input.job_id);
        if (!job) throw new Error("Ingest job not found");
        return job;
      }
      default:
        throw new AgentCommandNotImplementedError(`Command is not implemented yet: ${command.command}`);
    }
  }
}
