import type { AttemptedSource, IngestProblem, PaperQuery } from "./index";

export type PaperMatchConfidence = "exact_identifier" | "high_metadata";
export type FullTextFormat = "xml" | "html" | "pdf";
export type AcquisitionRoute = "clipper_core" | "mineru" | "clipper_extension";
export type AcquisitionPlanKind = "pmc_xml" | "public_html" | "public_pdf" | "clipper_extension" | "unavailable";

export interface ResolvedPaperIdentity {
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  identifiers: {
    pmid?: string;
    pmcid?: string;
    doi?: string;
  };
  landing_url?: string;
}

export interface PaperMatch {
  confidence: PaperMatchConfidence;
  identity: ResolvedPaperIdentity;
}

export type PaperMetadataProvider = "europe_pmc" | "crossref";

export interface PaperResolutionCandidate {
  identity: ResolvedPaperIdentity;
  /** Sørensen–Dice similarity over normalized title tokens, rounded to four decimals. */
  title_similarity: number;
  providers: PaperMetadataProvider[];
}

export interface FullTextSource {
  source_id: string;
  provider: "europe_pmc" | "unpaywall" | "publisher" | "repository";
  format: FullTextFormat;
  url: string;
  access: "open_access";
  acquisition_route: AcquisitionRoute;
  priority: number;
  license?: string;
  version?: string;
  requires_domain_permission: boolean;
  requires_browser_session: boolean;
}

export type PaperResolutionStatus = "resolved" | "needs_attention" | "not_found";

export interface PaperResolution {
  status: PaperResolutionStatus;
  query: PaperQuery;
  match?: PaperMatch;
  full_text_sources: FullTextSource[];
  recommended_source_id?: string;
  attempted_sources: AttemptedSource[];
  /** Bounded, deterministically ranked candidates returned when a title cannot be selected safely. */
  candidates?: PaperResolutionCandidate[];
  problem?: IngestProblem;
}

export interface AcquisitionPlan {
  kind: AcquisitionPlanKind;
  source?: FullTextSource;
  alternatives: FullTextSource[];
  requires_confirmation: boolean;
  reason: string;
}

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeTitle(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeTitle(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach((token) => { if (rightTokens.has(token)) intersection += 1; });
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function metadataRecordsConflict(
  left: Pick<ResolvedPaperIdentity, "title" | "year">,
  right: Pick<ResolvedPaperIdentity, "title" | "year">
): boolean {
  if (left.year && right.year && Math.abs(left.year - right.year) > 1) return true;
  return Boolean(left.title && right.title && titleTokenSimilarity(left.title, right.title) < 0.65);
}

export function rankFullTextSources(sources: readonly FullTextSource[]): FullTextSource[] {
  const byUrl = new Map<string, FullTextSource>();
  sources.forEach((source) => {
    const existing = byUrl.get(source.url);
    if (!existing || source.priority < existing.priority) byUrl.set(source.url, { ...source });
  });
  return [...byUrl.values()].sort((left, right) =>
    left.priority - right.priority
    || left.provider.localeCompare(right.provider)
    || left.format.localeCompare(right.format)
    || left.url.localeCompare(right.url)
  );
}

/** Selects a deterministic acquisition route without performing network or browser actions. */
export function planFullTextAcquisition(sources: readonly FullTextSource[]): AcquisitionPlan {
  const ranked = rankFullTextSources(sources);
  const automatic = ranked.find((source) => !source.requires_browser_session
    && !source.requires_domain_permission
    && (source.acquisition_route === "clipper_core" || source.acquisition_route === "mineru"));
  if (automatic) {
    const kind: AcquisitionPlanKind = automatic.format === "xml"
      ? "pmc_xml"
      : automatic.format === "pdf" ? "public_pdf" : "public_html";
    return {
      kind,
      source: { ...automatic },
      alternatives: ranked.filter((source) => source.source_id !== automatic.source_id),
      requires_confirmation: kind === "public_pdf",
      reason: kind === "public_pdf"
        ? "A verified open PDF can be staged for deterministic MinerU extraction after user-authorized ingest"
        : "A session-free open full-text source can be clipped deterministically"
    };
  }
  const extension = ranked.find((source) => source.acquisition_route === "clipper_extension"
    || source.requires_browser_session || source.requires_domain_permission);
  if (extension) {
    return {
      kind: "clipper_extension",
      source: { ...extension },
      alternatives: ranked.filter((source) => source.source_id !== extension.source_id),
      requires_confirmation: true,
      reason: "The full text requires an explicitly authorized browser-session handoff"
    };
  }
  return {
    kind: "unavailable",
    alternatives: ranked,
    requires_confirmation: false,
    reason: "No supported legal full-text acquisition route is available"
  };
}
