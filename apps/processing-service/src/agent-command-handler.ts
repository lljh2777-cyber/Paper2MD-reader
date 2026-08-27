import type { AgentCommand } from "../../../packages/agent-contracts/src/index";
import { PaperResolver } from "./paper-resolver";

export class AgentCommandNotImplementedError extends Error {}

export class AgentCommandHandler {
  constructor(private readonly resolver: PaperResolver) {}

  async execute(command: AgentCommand): Promise<unknown> {
    switch (command.command) {
      case "get_service_status":
        return {
          status: "ok",
          extraction: "mineru-precision",
          formats: ["md", "json"],
          resolver_query_kinds: ["pmid", "pmcid", "doi"],
          agent_transport: "http-command"
        };
      case "resolve_paper":
        return this.resolver.resolve(command.input.query);
      default:
        throw new AgentCommandNotImplementedError(`Command is not implemented yet: ${command.command}`);
    }
  }
}
