export type ProcessingJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ProcessingStage = "extract" | "validate" | "publish" | "complete";

export interface PublishedPackageFile {
  path: string;
  size: number;
  sha256: string;
}

export interface PublishedPackageDescriptor {
  packageId: string;
  label: string;
  files: PublishedPackageFile[];
}

export interface ProcessingJob {
  id: string;
  filename: string;
  state: ProcessingJobState;
  stage: ProcessingStage;
  message: string;
  createdAt: string;
  updatedAt: string;
  package?: PublishedPackageDescriptor;
}

export const INGEST_ERROR_CODES = [
  "PAPER_NOT_FOUND",
  "AMBIGUOUS_MATCH",
  "FULL_TEXT_NOT_AVAILABLE",
  "LOGIN_REQUIRED",
  "PAYWALL_RESTRICTED",
  "DOMAIN_PERMISSION_REQUIRED",
  "ANTI_BOT_CHALLENGE",
  "CLIPPER_UNSUPPORTED",
  "QUERY_KIND_NOT_SUPPORTED",
  "METADATA_SERVICE_UNAVAILABLE",
  "EXTRACTION_FAILED",
  "PACKAGE_VALIDATION_FAILED"
] as const;

export type IngestErrorCode = typeof INGEST_ERROR_CODES[number];
export type PaperQueryKind = "pmid" | "pmcid" | "doi" | "url" | "title";

export interface PaperQuery {
  kind: PaperQueryKind;
  /** A canonical identifier or whitespace-normalized title. */
  value: string;
  /** The trimmed user input, retained for audit display only. */
  original: string;
}

export type IngestState =
  | "queued"
  | "resolving"
  | "matched"
  | "acquiring"
  | "clipping"
  | "extracting"
  | "validating"
  | "publishing"
  | "ready"
  | "needs_attention"
  | "failed"
  | "cancelled";

export interface AttemptedSource {
  provider: string;
  locator: string;
  outcome: "available" | "not_found" | "unavailable" | "restricted" | "unsupported" | "failed";
  detail?: string;
}

export interface IngestProblem {
  code: IngestErrorCode;
  message: string;
  attempted_sources: AttemptedSource[];
  next_steps: string[];
}

export interface IngestJob {
  job_id: string;
  state: IngestState;
  query: PaperQuery;
  created_at: string;
  updated_at: string;
  message: string;
  package_id?: string;
  reader_url?: string;
  problem?: IngestProblem;
}

export type AgentCommandEffect = "read" | "network" | "write" | "confirmed_write" | "ui";

export const AGENT_COMMANDS = {
  get_service_status: { effect: "read" },
  resolve_paper: { effect: "network" },
  ingest_paper: { effect: "write" },
  get_ingest_job: { effect: "read" },
  list_packages: { effect: "read" },
  read_package_manifest: { effect: "read" },
  read_article_section: { effect: "read" },
  list_figures: { effect: "read" },
  get_visual_repair_candidates: { effect: "read" },
  validate_visual_correction: { effect: "read" },
  apply_visual_correction: { effect: "confirmed_write" },
  open_reader: { effect: "ui" }
} as const satisfies Record<string, { effect: AgentCommandEffect }>;

export type AgentCommandName = keyof typeof AGENT_COMMANDS;

export interface VisualCorrectionInput {
  kind: "full_page_visual" | "cross_page_caption";
  visual_block_id: string;
  member_block_ids?: string[];
  caption_block_ids?: string[];
}

export interface AgentCommandInputMap {
  get_service_status: Record<string, never>;
  resolve_paper: { query: string };
  ingest_paper: { query: string };
  get_ingest_job: { job_id: string };
  list_packages: { cursor?: string; limit?: number };
  read_package_manifest: { package_id: string };
  read_article_section: { package_id: string; heading_id?: string; start_line?: number; max_lines?: number };
  list_figures: { package_id: string };
  get_visual_repair_candidates: { package_id: string };
  validate_visual_correction: { package_id: string; candidate_id: string; correction: VisualCorrectionInput };
  apply_visual_correction: {
    package_id: string;
    candidate_id: string;
    correction: VisualCorrectionInput;
    validation_token: string;
    confirm: true;
  };
  open_reader: { package_id: string };
}

export type AgentCommand<Name extends AgentCommandName = AgentCommandName> = {
  [CommandName in Name]: {
    command: CommandName;
    input: AgentCommandInputMap[CommandName];
  }
}[Name];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PMID = /^(?:pmid\s*:\s*)?(\d{1,9})$/i;
const PMCID = /^(?:pmcid\s*:\s*)?(PMC\d+)$/i;
const DOI = /^(?:doi\s*:\s*)?(10\.\d{4,9}\/\S+)$/i;

function normalizedDoi(value: string): string {
  return value.replace(/[.,;]+$/, "").toLowerCase();
}

export function parsePaperQuery(input: string): PaperQuery {
  const original = input.trim();
  if (!original || original.length > 2_048 || CONTROL_CHARACTERS.test(original)) {
    throw new Error("Paper query must be between 1 and 2048 printable characters");
  }
  const pmcid = PMCID.exec(original);
  if (pmcid) return { kind: "pmcid", value: pmcid[1].toUpperCase(), original };
  const pmid = PMID.exec(original);
  if (pmid) return { kind: "pmid", value: pmid[1], original };

  const doi = DOI.exec(original);
  if (doi) return { kind: "doi", value: normalizedDoi(doi[1]), original };
  if (/^(?:pmid|pmcid|doi)\s*:/i.test(original)) {
    throw new Error("Paper identifier prefix is present but the identifier is invalid");
  }

  let url: URL | undefined;
  try {
    url = new URL(original);
  } catch {
    // A non-URL is treated as a title below.
  }
  if (url) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("Paper URL must use HTTP(S) and must not contain credentials");
    }
    if (url.hostname.toLowerCase() === "doi.org" || url.hostname.toLowerCase() === "dx.doi.org") {
      const pathDoi = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!DOI.test(pathDoi)) throw new Error("doi.org URL does not contain a valid DOI");
      return { kind: "doi", value: normalizedDoi(pathDoi), original };
    }
    url.hash = "";
    return { kind: "url", value: url.href, original };
  }

  const title = original.replace(/\s+/g, " ");
  if (title.length < 4) throw new Error("Paper title is too short to resolve safely");
  return { kind: "title", value: title, original };
}

const INGEST_TRANSITIONS: Readonly<Record<IngestState, readonly IngestState[]>> = {
  queued: ["resolving", "failed", "cancelled"],
  resolving: ["matched", "needs_attention", "failed", "cancelled"],
  matched: ["acquiring", "needs_attention", "failed", "cancelled"],
  acquiring: ["clipping", "extracting", "needs_attention", "failed", "cancelled"],
  clipping: ["validating", "needs_attention", "failed", "cancelled"],
  extracting: ["validating", "failed", "cancelled"],
  validating: ["publishing", "failed", "cancelled"],
  publishing: ["ready", "failed"],
  ready: [],
  needs_attention: ["resolving", "acquiring", "cancelled"],
  failed: [],
  cancelled: []
};

export function canTransitionIngestState(from: IngestState, to: IngestState): boolean {
  return INGEST_TRANSITIONS[from].includes(to);
}

export function assertIngestStateTransition(from: IngestState, to: IngestState): void {
  if (!canTransitionIngestState(from, to)) {
    throw new Error(`Invalid ingest state transition: ${from} -> ${to}`);
  }
}

export function assertOpaqueId(value: string, label: "job_id" | "package_id" | "candidate_id" | "validation_token"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function agentCommandEffect(command: AgentCommandName): AgentCommandEffect {
  return AGENT_COMMANDS[command].effect;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function optionalText(value: unknown, label: string, maximum = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be non-empty printable text of at most ${maximum} characters`);
  }
  return value.trim();
}

function opaqueId(
  value: unknown,
  label: "job_id" | "package_id" | "candidate_id" | "validation_token"
): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return assertOpaqueId(value, label);
}

function blockIds(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain between ${minimum} and ${maximum} block IDs`);
  }
  const result = value.map((item) => opaqueId(item, "candidate_id"));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate block IDs`);
  return result;
}

function parseVisualCorrection(value: unknown): VisualCorrectionInput {
  const input = object(value, "correction");
  exactKeys(input, ["kind", "visual_block_id", "member_block_ids", "caption_block_ids"], "correction");
  const visualBlockId = opaqueId(input.visual_block_id, "candidate_id");
  if (input.kind === "full_page_visual") {
    if (input.caption_block_ids !== undefined) throw new Error("full_page_visual cannot contain caption_block_ids");
    return {
      kind: input.kind,
      visual_block_id: visualBlockId,
      member_block_ids: blockIds(input.member_block_ids, "member_block_ids", 2, 64)
    };
  }
  if (input.kind === "cross_page_caption") {
    if (input.member_block_ids !== undefined) throw new Error("cross_page_caption cannot contain member_block_ids");
    return {
      kind: input.kind,
      visual_block_id: visualBlockId,
      caption_block_ids: blockIds(input.caption_block_ids, "caption_block_ids", 1, 2)
    };
  }
  throw new Error("Unsupported visual correction kind");
}

/** Runtime boundary for MCP, WebMCP, HTTP, and extension messages. */
export function parseAgentCommand(value: unknown): AgentCommand {
  const envelope = object(value, "Agent command");
  exactKeys(envelope, ["command", "input"], "Agent command");
  if (typeof envelope.command !== "string" || !Object.hasOwn(AGENT_COMMANDS, envelope.command)) {
    throw new Error("Unsupported agent command");
  }
  const command = envelope.command as AgentCommandName;
  const input = object(envelope.input, `${command} input`);

  switch (command) {
    case "get_service_status":
      exactKeys(input, [], `${command} input`);
      return { command, input: {} };
    case "resolve_paper":
    case "ingest_paper": {
      exactKeys(input, ["query"], `${command} input`);
      if (typeof input.query !== "string") throw new Error("query must be a string");
      const query = parsePaperQuery(input.query).original;
      return { command, input: { query } };
    }
    case "get_ingest_job":
      exactKeys(input, ["job_id"], `${command} input`);
      return { command, input: { job_id: opaqueId(input.job_id, "job_id") } };
    case "list_packages": {
      exactKeys(input, ["cursor", "limit"], `${command} input`);
      const cursor = input.cursor === undefined ? undefined : opaqueId(input.cursor, "package_id");
      const limit = optionalInteger(input.limit, "limit", 1, 100);
      return { command, input: { cursor, limit } };
    }
    case "read_package_manifest":
    case "list_figures":
    case "get_visual_repair_candidates":
    case "open_reader":
      exactKeys(input, ["package_id"], `${command} input`);
      return { command, input: { package_id: opaqueId(input.package_id, "package_id") } } as AgentCommand;
    case "read_article_section": {
      exactKeys(input, ["package_id", "heading_id", "start_line", "max_lines"], `${command} input`);
      return {
        command,
        input: {
          package_id: opaqueId(input.package_id, "package_id"),
          heading_id: optionalText(input.heading_id, "heading_id"),
          start_line: optionalInteger(input.start_line, "start_line", 1, 10_000_000),
          max_lines: optionalInteger(input.max_lines, "max_lines", 1, 500)
        }
      };
    }
    case "validate_visual_correction": {
      exactKeys(input, ["package_id", "candidate_id", "correction"], `${command} input`);
      return {
        command,
        input: {
          package_id: opaqueId(input.package_id, "package_id"),
          candidate_id: opaqueId(input.candidate_id, "candidate_id"),
          correction: parseVisualCorrection(input.correction)
        }
      };
    }
    case "apply_visual_correction": {
      exactKeys(input, ["package_id", "candidate_id", "correction", "validation_token", "confirm"], `${command} input`);
      if (input.confirm !== true) throw new Error("apply_visual_correction requires explicit confirmation");
      return {
        command,
        input: {
          package_id: opaqueId(input.package_id, "package_id"),
          candidate_id: opaqueId(input.candidate_id, "candidate_id"),
          correction: parseVisualCorrection(input.correction),
          validation_token: opaqueId(input.validation_token, "validation_token"),
          confirm: true
        }
      };
    }
  }
}

export * from "./paper-resolution";
