import {
  AttemptedSource,
  FullTextSource,
  IngestErrorCode,
  PaperQuery,
  PaperResolution,
  ResolvedPaperIdentity,
  metadataRecordsConflict,
  parsePaperQuery,
  rankFullTextSources
} from "../../../packages/agent-contracts/src/index";

const EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const EUROPE_PMC_FULL_TEXT = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const CROSSREF_WORKS = "https://api.crossref.org/works";
const UNPAYWALL_API = "https://api.unpaywall.org/v2";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export interface PaperResolverOptions {
  fetch?: typeof fetch;
  contactEmail?: string;
  timeoutMilliseconds?: number;
}

interface ProviderResult {
  status: number;
  value?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalDoi(value: unknown): string | undefined {
  return text(value)?.toLowerCase().replace(/[.,;]+$/, "");
}

function numericYear(value: unknown): number | undefined {
  const year = Number(value);
  return Number.isSafeInteger(year) && year >= 1400 && year <= 3000 ? year : undefined;
}

function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4_096) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") || host.includes(":")) return undefined;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return undefined;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [first, second] = ipv4.slice(1).map(Number);
    if (first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))) return undefined;
  }
  url.hash = "";
  return url.href;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_METADATA_BYTES) throw new Error("Metadata response exceeds the configured limit");
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) {
        await reader.cancel("Metadata response exceeds the configured limit");
        throw new Error("Metadata response exceeds the configured limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function europeQuery(query: PaperQuery): string {
  if (query.kind === "pmid") return `EXT_ID:${query.value} AND SRC:MED`;
  if (query.kind === "pmcid") return `PMCID:${query.value}`;
  const escapedDoi = query.value.replace(/([\\"])/g, "\\$1");
  return `DOI:\"${escapedDoi}\"`;
}

function europeRecord(response: unknown, query: PaperQuery): Record<string, unknown> | undefined {
  const results = object(object(response)?.resultList)?.result;
  if (!Array.isArray(results)) return undefined;
  const exact = results.filter((item) => {
    const candidate = object(item);
    if (!candidate) return false;
    if (query.kind === "pmid") return String(candidate.pmid ?? candidate.id ?? "") === query.value;
    if (query.kind === "pmcid") return text(candidate.pmcid)?.toUpperCase() === query.value;
    return canonicalDoi(candidate.doi) === query.value;
  });
  if (exact.length > 1) throw new Error("Europe PMC returned multiple exact identifier matches");
  return object(exact[0]);
}

function europeIdentity(record: Record<string, unknown>): ResolvedPaperIdentity | undefined {
  const title = text(record.title);
  if (!title) return undefined;
  const authorItems = object(record.authorList)?.author;
  const authors = Array.isArray(authorItems)
    ? authorItems.flatMap((item) => {
      const author = object(item);
      const name = text(author?.fullName) ?? [text(author?.firstName), text(author?.lastName)].filter(Boolean).join(" ");
      return name ? [name] : [];
    })
    : [];
  const doi = canonicalDoi(record.doi);
  return {
    title,
    authors,
    year: numericYear(record.pubYear),
    journal: text(record.journalTitle),
    identifiers: {
      pmid: text(record.pmid),
      pmcid: text(record.pmcid)?.toUpperCase(),
      doi
    },
    landing_url: doi ? `https://doi.org/${doi}` : undefined
  };
}

function europeSources(record: Record<string, unknown>, identity: ResolvedPaperIdentity): FullTextSource[] {
  const sources: FullTextSource[] = [];
  if (record.isOpenAccess === "Y" && identity.identifiers.pmcid) {
    const pmcid = identity.identifiers.pmcid;
    sources.push({
      source_id: `epmc-xml-${pmcid.toLowerCase()}`,
      provider: "europe_pmc",
      format: "xml",
      url: `${EUROPE_PMC_FULL_TEXT}/${encodeURIComponent(pmcid)}/fullTextXML`,
      access: "open_access",
      acquisition_route: "clipper_core",
      priority: 10,
      requires_domain_permission: false,
      requires_browser_session: false
    });
    sources.push({
      source_id: `pmc-html-${pmcid.toLowerCase()}`,
      provider: "europe_pmc",
      format: "html",
      url: `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(pmcid)}/`,
      access: "open_access",
      acquisition_route: "clipper_core",
      priority: 20,
      requires_domain_permission: false,
      requires_browser_session: false
    });
  }
  const urls = object(record.fullTextUrlList)?.fullTextUrl;
  if (!Array.isArray(urls)) return sources;
  urls.forEach((item, index) => {
    const entry = object(item);
    if (!entry || entry.availabilityCode !== "OA") return;
    const url = publicHttpsUrl(entry.url);
    const style = text(entry.documentStyle)?.toLowerCase();
    if (!url || (style !== "html" && style !== "pdf")) return;
    if (style === "html" && identity.identifiers.pmcid) return;
    sources.push({
      source_id: `epmc-${style}-${index + 1}`,
      provider: "europe_pmc",
      format: style,
      url,
      access: "open_access",
      acquisition_route: style === "pdf" ? "mineru" : "clipper_core",
      priority: style === "pdf" ? 50 : 20,
      requires_domain_permission: false,
      requires_browser_session: false
    });
  });
  return sources;
}

function crossrefIdentity(response: unknown, requestedDoi: string): ResolvedPaperIdentity | undefined {
  const message = object(object(response)?.message);
  if (!message || canonicalDoi(message.DOI) !== requestedDoi) return undefined;
  const titles = message.title;
  const title = Array.isArray(titles) ? text(titles[0]) : text(titles);
  if (!title) return undefined;
  const authorItems = message.author;
  const authors = Array.isArray(authorItems)
    ? authorItems.flatMap((item) => {
      const author = object(item);
      const name = [text(author?.given), text(author?.family)].filter(Boolean).join(" ");
      return name ? [name] : [];
    })
    : [];
  const dateParts = [message.published, message["published-print"], message["published-online"], message.issued]
    .flatMap((date) => {
      const parts = object(date)?.["date-parts"];
      return Array.isArray(parts) && Array.isArray(parts[0]) ? [parts[0][0]] : [];
    });
  return {
    title,
    authors,
    year: dateParts.map(numericYear).find((year) => year !== undefined),
    journal: Array.isArray(message["container-title"]) ? text(message["container-title"][0]) : undefined,
    identifiers: { doi: requestedDoi },
    landing_url: `https://doi.org/${requestedDoi}`
  };
}

function unpaywallSources(response: unknown, requestedDoi: string): FullTextSource[] {
  const root = object(response);
  if (!root || root.is_oa !== true || canonicalDoi(root.doi) !== requestedDoi) return [];
  const best = object(root.best_oa_location);
  const locations = Array.isArray(root.oa_locations) ? root.oa_locations.map(object).filter(Boolean) as Record<string, unknown>[] : [];
  const ordered = best ? [best, ...locations.filter((location) => location !== best)] : locations;
  const sources: FullTextSource[] = [];
  ordered.forEach((location, index) => {
    const provider = location.host_type === "publisher" ? "publisher" : "repository";
    const license = text(location.license);
    const version = text(location.version);
    const landing = publicHttpsUrl(location.url_for_landing_page ?? location.url);
    const pdf = publicHttpsUrl(location.url_for_pdf);
    if (landing) {
      sources.push({
        source_id: `unpaywall-html-${index + 1}`,
        provider,
        format: "html",
        url: landing,
        access: "open_access",
        acquisition_route: "clipper_core",
        priority: provider === "publisher" ? 30 + index : 40 + index,
        license,
        version,
        requires_domain_permission: false,
        requires_browser_session: false
      });
    }
    if (pdf) {
      sources.push({
        source_id: `unpaywall-pdf-${index + 1}`,
        provider,
        format: "pdf",
        url: pdf,
        access: "open_access",
        acquisition_route: "mineru",
        priority: provider === "publisher" ? 60 + index : 70 + index,
        license,
        version,
        requires_domain_permission: false,
        requires_browser_session: false
      });
    }
  });
  return sources;
}

function mergeIdentities(primary: ResolvedPaperIdentity, secondary?: ResolvedPaperIdentity): ResolvedPaperIdentity {
  if (!secondary) return primary;
  return {
    title: primary.title,
    authors: primary.authors.length ? primary.authors : secondary.authors,
    year: primary.year ?? secondary.year,
    journal: primary.journal ?? secondary.journal,
    identifiers: {
      pmid: primary.identifiers.pmid ?? secondary.identifiers.pmid,
      pmcid: primary.identifiers.pmcid ?? secondary.identifiers.pmcid,
      doi: primary.identifiers.doi ?? secondary.identifiers.doi
    },
    landing_url: primary.landing_url ?? secondary.landing_url
  };
}

function problem(
  query: PaperQuery,
  code: IngestErrorCode,
  message: string,
  attemptedSources: AttemptedSource[],
  match?: { confidence: "exact_identifier"; identity: ResolvedPaperIdentity }
): PaperResolution {
  return {
    status: code === "PAPER_NOT_FOUND" || code === "METADATA_SERVICE_UNAVAILABLE" ? "not_found" : "needs_attention",
    query,
    match,
    full_text_sources: [],
    attempted_sources: attemptedSources,
    problem: { code, message, attempted_sources: attemptedSources, next_steps: code === "FULL_TEXT_NOT_AVAILABLE"
      ? ["Open a supported publisher page with the Clipper extension", "Upload a legally obtained PDF for MinerU extraction"]
      : code === "QUERY_KIND_NOT_SUPPORTED"
        ? ["Use a PMID, PMCID, or DOI"]
        : ["Verify the identifier and retry later"] }
  };
}

export class PaperResolver {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: PaperResolverOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 12_000;
  }

  private async fetchJson(url: URL, userAgent: string): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImplementation(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": userAgent },
        redirect: "error",
        signal: controller.signal
      });
      if (response.status === 404) return { status: 404 };
      if (!response.ok) throw new Error(`Metadata provider returned HTTP ${response.status}`);
      return { status: response.status, value: await boundedJson(response) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolve(input: string): Promise<PaperResolution> {
    const query = parsePaperQuery(input);
    const attempted: AttemptedSource[] = [];
    if (query.kind === "title" || query.kind === "url") {
      return problem(query, "QUERY_KIND_NOT_SUPPORTED", "This resolver phase accepts PMID, PMCID, or DOI queries", attempted);
    }
    const userAgent = this.options.contactEmail
      ? `Paper2MD-Reader/0.1 (mailto:${this.options.contactEmail})`
      : "Paper2MD-Reader/0.1";

    let europe: Record<string, unknown> | undefined;
    let europeFailed = false;
    const europeUrl = new URL(EUROPE_PMC_SEARCH);
    europeUrl.searchParams.set("query", europeQuery(query));
    europeUrl.searchParams.set("resultType", "core");
    europeUrl.searchParams.set("pageSize", "2");
    europeUrl.searchParams.set("format", "json");
    if (this.options.contactEmail) europeUrl.searchParams.set("email", this.options.contactEmail);
    try {
      const response = await this.fetchJson(europeUrl, userAgent);
      europe = europeRecord(response.value, query);
      attempted.push({
        provider: "europe_pmc",
        locator: `${query.kind}:${query.value}`,
        outcome: europe ? "available" : "not_found"
      });
    } catch (error) {
      europeFailed = true;
      attempted.push({ provider: "europe_pmc", locator: `${query.kind}:${query.value}`, outcome: "failed", detail: error instanceof Error ? error.message : "Request failed" });
    }

    let crossref: ResolvedPaperIdentity | undefined;
    let crossrefFailed = false;
    if (query.kind === "doi") {
      const crossrefUrl = new URL(`${CROSSREF_WORKS}/${encodeURIComponent(query.value)}`);
      if (this.options.contactEmail) crossrefUrl.searchParams.set("mailto", this.options.contactEmail);
      try {
        const response = await this.fetchJson(crossrefUrl, userAgent);
        crossref = response.status === 404 ? undefined : crossrefIdentity(response.value, query.value);
        attempted.push({ provider: "crossref", locator: `doi:${query.value}`, outcome: crossref ? "available" : "not_found" });
      } catch (error) {
        crossrefFailed = true;
        attempted.push({ provider: "crossref", locator: `doi:${query.value}`, outcome: "failed", detail: error instanceof Error ? error.message : "Request failed" });
      }
    }

    const europePaper = europe ? europeIdentity(europe) : undefined;
    if (europePaper && crossref && metadataRecordsConflict(europePaper, crossref)) {
      return problem(query, "AMBIGUOUS_MATCH", "Metadata providers returned conflicting title or year data", attempted);
    }
    const primary = query.kind === "doi" ? crossref ?? europePaper : europePaper;
    if (!primary) {
      const unavailable = europeFailed && (query.kind !== "doi" || crossrefFailed);
      return problem(
        query,
        unavailable ? "METADATA_SERVICE_UNAVAILABLE" : "PAPER_NOT_FOUND",
        unavailable ? "All applicable metadata providers were unavailable" : "No exact identifier match was found",
        attempted
      );
    }
    const identity = mergeIdentities(primary, primary === crossref ? europePaper : crossref);
    let sources = europe && europePaper ? europeSources(europe, identity) : [];

    if (identity.identifiers.doi && this.options.contactEmail) {
      const unpaywallUrl = new URL(`${UNPAYWALL_API}/${encodeURIComponent(identity.identifiers.doi)}`);
      unpaywallUrl.searchParams.set("email", this.options.contactEmail);
      try {
        const response = await this.fetchJson(unpaywallUrl, userAgent);
        const oaSources = response.status === 404 ? [] : unpaywallSources(response.value, identity.identifiers.doi);
        sources = sources.concat(oaSources);
        attempted.push({
          provider: "unpaywall",
          locator: `doi:${identity.identifiers.doi}`,
          outcome: oaSources.length ? "available" : "unavailable",
          detail: oaSources.length ? undefined : "No verified open-access location was returned"
        });
      } catch (error) {
        attempted.push({ provider: "unpaywall", locator: `doi:${identity.identifiers.doi}`, outcome: "failed", detail: error instanceof Error ? error.message : "Request failed" });
      }
    }

    sources = rankFullTextSources(sources);
    const match = { confidence: "exact_identifier" as const, identity };
    if (!sources.length) {
      return problem(query, "FULL_TEXT_NOT_AVAILABLE", "The paper was identified, but no legal open full-text source was verified", attempted, match);
    }
    return {
      status: "resolved",
      query,
      match,
      full_text_sources: sources,
      recommended_source_id: sources[0].source_id,
      attempted_sources: attempted
    };
  }
}
