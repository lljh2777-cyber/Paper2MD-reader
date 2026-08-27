import type { AgentCommand } from "../../../packages/agent-contracts/src/index";
import { PaperResolver } from "./paper-resolver";
import { IngestManager } from "./ingest-manager";
import { PublishedPackageCatalog } from "./published-package-catalog";
import { VisualCorrectionManager } from "./visual-correction-manager";

export class AgentCommandNotImplementedError extends Error {}

export class AgentCommandHandler {
  constructor(
    private readonly resolver: PaperResolver,
    private readonly ingests: IngestManager,
    private readonly packages: PublishedPackageCatalog,
    private readonly visualCorrections: VisualCorrectionManager,
    private readonly mcpHttpEnabled = false
  ) {}

  async execute(command: AgentCommand): Promise<unknown> {
    switch (command.command) {
      case "get_service_status":
        return {
          status: "ok",
          extraction: "mineru-precision",
          formats: ["md", "json"],
          resolver_query_kinds: ["pmid", "pmcid", "doi", "supported_url", "title"],
          ingest_query_kinds: ["pmid", "pmcid", "doi", "supported_url", "title"],
          automatic_ingest_sources: ["pmc-open-xml", "pmc-open-html", "public-open-html", "public-open-pdf"],
          clipper_submission: "multipart-v1",
          clipper_publication: "staged-validated-atomic",
          agent_transport: "http-command",
          available_agent_transports: ["http-command", "mcp-stdio-sidecar", ...(this.mcpHttpEnabled ? ["mcp-streamable-http-local"] : [])],
          available_agent_commands: [
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
          ]
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
      case "list_packages":
        return this.packages.list(command.input.cursor, command.input.limit);
      case "read_package_manifest":
        return this.packages.readManifest(command.input.package_id);
      case "read_article_section":
        return this.packages.readArticleSection(command.input);
      case "list_figures":
        return this.packages.listFigures(command.input.package_id);
      case "get_visual_repair_candidates":
        return this.visualCorrections.list(command.input.package_id);
      case "validate_visual_correction":
        return this.visualCorrections.validate(command.input.package_id, command.input.candidate_id, command.input.correction);
      case "apply_visual_correction":
        return this.visualCorrections.apply(
          command.input.package_id,
          command.input.candidate_id,
          command.input.correction,
          command.input.validation_token
        );
      default:
        throw new AgentCommandNotImplementedError(`Command is not implemented yet: ${command.command}`);
    }
  }
}
