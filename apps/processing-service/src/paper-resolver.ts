import {
  AttemptedSource,
  FullTextSource,
  IngestErrorCode,
  PaperMatch,
  PaperMetadataProvider,
  PaperQuery,
  PaperResolution,
  PaperResolutionCandidate,
  ResolvedPaperIdentity,
  metadataRecordsConflict,
  normalizeTitle,
  parsePaperQuery,
  rankFullTextSources,
  titleTokenSimilarity
} from "../../../packages/agent-contracts/src/index";

const EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const EUROPE_PMC_FULL_TEXT = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const CROSSREF_WORKS = "https://api.crossref.org/works";
const UNPAYWALL_API = "https://api.unpaywall.org/v2";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_PROVIDER_RESULTS = 6;
const MAX_TITLE_CANDIDATES = 5;
const MIN_RELEVANT_TITLE_SIMILARITY = 0.65;
const HIGH_TITLE_SIMILARITY = 0.92;
const MIN_TITLE_LEAD = 0.08;

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
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 4_096 ? result : undefined;
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

function europeExactQuery(query: PaperQuery): string {
  if (query.kind === "pmid") return `EXT_ID:${query.value} AND SRC:MED`;
  if (query.kind === "pmcid") return `PMCID:${query.value}`;
  const escapedDoi = query.value.replace(/([\\"])/g, "\\$1");
  return `DOI:\"${escapedDoi}\"`;
}

function titlePhrase(value: string): string {
  return value.replace(/([\\"])/g, "\\$1");
}

function titleLocator(value: string): string {
  return `title:${value.slice(0, 512)}`;
}

function europeRecords(response: unknown): Record<string, unknown>[] {
  const results = object(object(response)?.resultList)?.result;
  return Array.isArray(results)
    ? results.slice(0, MAX_TITLE_PROVIDER_RESULTS).map(object).filter(Boolean) as Record<string, unknown>[]
    : [];
}

function europeRecord(response: unknown, query: PaperQuery): Record<string, unknown> | undefined {
  const exact = europeRecords(response).filter((candidate) => {
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

function crossrefMessageIdentity(message: Record<string, unknown>, requestedDoi?: string): ResolvedPaperIdentity | undefined {
  const doi = canonicalDoi(message.DOI);
  if (!doi || (requestedDoi && doi !== requestedDoi)) return undefined;
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
    identifiers: { doi },
    landing_url: `https://doi.org/${doi}`
  };
}

function crossrefIdentity(response: unknown, requestedDoi: string): ResolvedPaperIdentity | undefined {
  const message = object(object(response)?.message);
  return message ? crossrefMessageIdentity(message, requestedDoi) : undefined;
}

function crossrefSearchIdentities(response: unknown): ResolvedPaperIdentity[] {
  const items = object(response)?.message;
  const works = object(items)?.items;
  if (!Array.isArray(works)) return [];
  return works
    .slice(0, MAX_TITLE_PROVIDER_RESULTS)
    .flatMap((item) => {
      const work = object(item);
      const identity = work ? crossrefMessageIdentity(work) : undefined;
      return identity ? [identity] : [];
    });
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

interface ProviderTitleCandidate {
  identity: ResolvedPaperIdentity;
  provider: PaperMetadataProvider;
}

type ExactResolverQuery = PaperQuery & { kind: "pmid" | "pmcid" | "doi" };
type TitleResolverQuery = PaperQuery & { kind: "title" };

function identifierConflict(left: ResolvedPaperIdentity, right: ResolvedPaperIdentity): boolean {
  return (["pmid", "pmcid", "doi"] as const).some((key) => {
    const leftValue = left.identifiers[key]?.toLowerCase();
    const rightValue = right.identifiers[key]?.toLowerCase();
    return Boolean(leftValue && rightValue && leftValue !== rightValue);
  });
}

function sharedIdentifier(left: ResolvedPaperIdentity, right: ResolvedPaperIdentity): boolean {
  return (["pmid", "pmcid", "doi"] as const).some((key) => {
    const leftValue = left.identifiers[key]?.toLowerCase();
    return Boolean(leftValue && leftValue === right.identifiers[key]?.toLowerCase());
  });
}

function sameTitleCandidate(left: ResolvedPaperIdentity, right: ResolvedPaperIdentity): boolean {
  if (identifierConflict(left, right) || metadataRecordsConflict(left, right)) return false;
  return sharedIdentifier(left, right);
}

function rankedTitleCandidates(queryTitle: string, input: readonly ProviderTitleCandidate[]): PaperResolutionCandidate[] {
  const groups: Array<{ identity: ResolvedPaperIdentity; providers: Set<PaperMetadataProvider> }> = [];
  input.forEach((candidate) => {
    if (titleTokenSimilarity(queryTitle, candidate.identity.title) < MIN_RELEVANT_TITLE_SIMILARITY) return;
    const existing = groups.find((group) => sameTitleCandidate(group.identity, candidate.identity));
    if (existing) {
      existing.identity = mergeIdentities(existing.identity, candidate.identity);
      existing.providers.add(candidate.provider);
      return;
    }
    groups.push({ identity: structuredClone(candidate.identity), providers: new Set([candidate.provider]) });
  });
  return groups
    .map((group) => ({
      identity: group.identity,
      title_similarity: Number(titleTokenSimilarity(queryTitle, group.identity.title).toFixed(4)),
      providers: [...group.providers].sort()
    }))
    .sort((left, right) =>
      right.title_similarity - left.title_similarity
      || right.providers.length - left.providers.length
      || (left.identity.identifiers.doi ?? "").localeCompare(right.identity.identifiers.doi ?? "")
      || left.identity.title.localeCompare(right.identity.title)
    )
    .slice(0, MAX_TITLE_CANDIDATES);
}

function highConfidenceTitleCandidate(queryTitle: string, candidates: readonly PaperResolutionCandidate[]): PaperResolutionCandidate | undefined {
  const top = candidates[0];
  if (!top || top.title_similarity < HIGH_TITLE_SIMILARITY || top.providers.length < 2) return undefined;
  if (!top.identity.identifiers.pmcid && !top.identity.identifiers.pmid && !top.identity.identifiers.doi) return undefined;
  const second = candidates[1];
  if (!second) return top;
  const exactTop = normalizeTitle(top.identity.title) === normalizeTitle(queryTitle);
  const exactSecond = normalizeTitle(second.identity.title) === normalizeTitle(queryTitle);
  return top.title_similarity - second.title_similarity >= MIN_TITLE_LEAD || (exactTop && !exactSecond) ? top : undefined;
}

function exactLookupQuery(identity: ResolvedPaperIdentity, original: string): ExactResolverQuery | undefined {
  if (identity.identifiers.doi) return { kind: "doi", value: identity.identifiers.doi, original };
  if (identity.identifiers.pmcid) return { kind: "pmcid", value: identity.identifiers.pmcid, original };
  if (identity.identifiers.pmid) return { kind: "pmid", value: identity.identifiers.pmid, original };
  return undefined;
}

function problemNextSteps(query: PaperQuery, code: IngestErrorCode, candidates?: PaperResolutionCandidate[]): string[] {
  if (code === "FULL_TEXT_NOT_AVAILABLE") {
    return ["Open a supported publisher page with the Clipper extension", "Upload a legally obtained PDF for MinerU extraction"];
  }
  if (code === "AMBIGUOUS_MATCH") {
    return candidates?.length
      ? ["Choose one candidate and retry with its PMID, PMCID, or DOI"]
      : ["Verify the exact identifier and resolve conflicting metadata before retrying"];
  }
  if (code === "QUERY_KIND_NOT_SUPPORTED") {
    return ["Use a PMID, PMCID, DOI, supported scholarly URL, or complete paper title", "Open the current page with the Clipper extension"];
  }
  if (code === "METADATA_SERVICE_UNAVAILABLE") return ["Retry after the metadata providers recover"];
  if (query.kind === "title") return ["Verify the complete title or retry with its PMID, PMCID, or DOI"];
  return ["Verify the identifier and retry later"];
}

function problem(
  query: PaperQuery,
  code: IngestErrorCode,
  message: string,
  attemptedSources: AttemptedSource[],
  match?: PaperMatch,
  candidates?: PaperResolutionCandidate[]
): PaperResolution {
  return {
    status: code === "PAPER_NOT_FOUND" ? "not_found" : "needs_attention",
    query,
    match,
    full_text_sources: [],
    attempted_sources: attemptedSources,
    candidates,
    problem: { code, message, attempted_sources: attemptedSources, next_steps: problemNextSteps(query, code, candidates) }
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

  private async resolveExact(
    lookupQuery: ExactResolverQuery,
    responseQuery: PaperQuery,
    userAgent: string,
    initialAttempts: readonly AttemptedSource[] = [],
    candidates?: PaperResolutionCandidate[],
    confidence: PaperMatch["confidence"] = "exact_identifier"
  ): Promise<PaperResolution> {
    const attempted: AttemptedSource[] = structuredClone([...initialAttempts]);
    let europe: Record<string, unknown> | undefined;
    let europeFailed = false;
    const europeUrl = new URL(EUROPE_PMC_SEARCH);
    europeUrl.searchParams.set("query", europeExactQuery(lookupQuery));
    europeUrl.searchParams.set("resultType", "core");
    europeUrl.searchParams.set("pageSize", "2");
    europeUrl.searchParams.set("format", "json");
    if (this.options.contactEmail) europeUrl.searchParams.set("email", this.options.contactEmail);
    try {
      const response = await this.fetchJson(europeUrl, userAgent);
      europe = europeRecord(response.value, lookupQuery);
      attempted.push({
        provider: "europe_pmc",
        locator: `${lookupQuery.kind}:${lookupQuery.value}`,
        outcome: europe ? "available" : "not_found"
      });
    } catch (error) {
      europeFailed = true;
      attempted.push({ provider: "europe_pmc", locator: `${lookupQuery.kind}:${lookupQuery.value}`, outcome: "failed", detail: error instanceof Error ? error.message : "Request failed" });
    }

    let crossref: ResolvedPaperIdentity | undefined;
    let crossrefFailed = false;
    if (lookupQuery.kind === "doi") {
      const crossrefUrl = new URL(`${CROSSREF_WORKS}/${encodeURIComponent(lookupQuery.value)}`);
      if (this.options.contactEmail) crossrefUrl.searchParams.set("mailto", this.options.contactEmail);
      try {
        const response = await this.fetchJson(crossrefUrl, userAgent);
        crossref = response.status === 404 ? undefined : crossrefIdentity(response.value, lookupQuery.value);
        attempted.push({ provider: "crossref", locator: `doi:${lookupQuery.value}`, outcome: crossref ? "available" : "not_found" });
      } catch (error) {
        crossrefFailed = true;
        attempted.push({ provider: "crossref", locator: `doi:${lookupQuery.value}`, outcome: "failed", detail: error instanceof Error ? error.message : "Request failed" });
      }
    }

    const europePaper = europe ? europeIdentity(europe) : undefined;
    if (europePaper && crossref && metadataRecordsConflict(europePaper, crossref)) {
      return problem(responseQuery, "AMBIGUOUS_MATCH", "Metadata providers returned conflicting title or year data", attempted, undefined, candidates);
    }
    const primary = lookupQuery.kind === "doi" ? crossref ?? europePaper : europePaper;
    if (!primary) {
      const unavailable = europeFailed && (lookupQuery.kind !== "doi" || crossrefFailed);
      return problem(
        responseQuery,
        unavailable ? "METADATA_SERVICE_UNAVAILABLE" : "PAPER_NOT_FOUND",
        unavailable ? "All applicable metadata providers were unavailable" : "No exact identifier match was found",
        attempted,
        undefined,
        candidates
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
    const match: PaperMatch = { confidence, identity };
    if (!sources.length) {
      return problem(responseQuery, "FULL_TEXT_NOT_AVAILABLE", "The paper was identified, but no legal open full-text source was verified", attempted, match, candidates);
    }
    return {
      status: "resolved",
      query: responseQuery,
      match,
      full_text_sources: sources,
      recommended_source_id: sources[0].source_id,
      attempted_sources: attempted,
      candidates
    };
  }

  private async resolveTitle(query: TitleResolverQuery, userAgent: string): Promise<PaperResolution> {
    const europeUrl = new URL(EUROPE_PMC_SEARCH);
    europeUrl.searchParams.set("query", `TITLE:\"${titlePhrase(query.value)}\"`);
    europeUrl.searchParams.set("resultType", "core");
    europeUrl.searchParams.set("pageSize", String(MAX_TITLE_PROVIDER_RESULTS));
    europeUrl.searchParams.set("format", "json");
    if (this.options.contactEmail) europeUrl.searchParams.set("email", this.options.contactEmail);

    const crossrefUrl = new URL(CROSSREF_WORKS);
    crossrefUrl.searchParams.set("query.title", query.value);
    crossrefUrl.searchParams.set("rows", String(MAX_TITLE_PROVIDER_RESULTS));
    if (this.options.contactEmail) crossrefUrl.searchParams.set("mailto", this.options.contactEmail);

    const [europeResult, crossrefResult] = await Promise.allSettled([
      this.fetchJson(europeUrl, userAgent),
      this.fetchJson(crossrefUrl, userAgent)
    ]);
    const attempted: AttemptedSource[] = [];
    const providerCandidates: ProviderTitleCandidate[] = [];
    if (europeResult.status === "fulfilled") {
      const identities = europeRecords(europeResult.value.value).flatMap((record) => {
        const identity = europeIdentity(record);
        return identity ? [identity] : [];
      });
      providerCandidates.push(...identities.map((identity) => ({ identity, provider: "europe_pmc" as const })));
      attempted.push({ provider: "europe_pmc", locator: titleLocator(query.value), outcome: identities.length ? "available" : "not_found" });
    } else {
      attempted.push({ provider: "europe_pmc", locator: titleLocator(query.value), outcome: "failed", detail: europeResult.reason instanceof Error ? europeResult.reason.message : "Request failed" });
    }
    if (crossrefResult.status === "fulfilled") {
      const identities = crossrefSearchIdentities(crossrefResult.value.value);
      providerCandidates.push(...identities.map((identity) => ({ identity, provider: "crossref" as const })));
      attempted.push({ provider: "crossref", locator: titleLocator(query.value), outcome: identities.length ? "available" : "not_found" });
    } else {
      attempted.push({ provider: "crossref", locator: titleLocator(query.value), outcome: "failed", detail: crossrefResult.reason instanceof Error ? crossrefResult.reason.message : "Request failed" });
    }

    const candidates = rankedTitleCandidates(query.value, providerCandidates);
    if (!candidates.length) {
      const providerFailed = europeResult.status === "rejected" || crossrefResult.status === "rejected";
      return problem(
        query,
        providerFailed ? "METADATA_SERVICE_UNAVAILABLE" : "PAPER_NOT_FOUND",
        providerFailed ? "Title matching could not be completed because a metadata provider was unavailable" : "No sufficiently similar paper title was found",
        attempted
      );
    }
    const selected = highConfidenceTitleCandidate(query.value, candidates);
    if (!selected) {
      return problem(
        query,
        "AMBIGUOUS_MATCH",
        "Title search did not produce one provider-corroborated candidate with a safe confidence lead",
        attempted,
        undefined,
        candidates
      );
    }
    const lookup = exactLookupQuery(selected.identity, query.original);
    if (!lookup) {
      return problem(query, "AMBIGUOUS_MATCH", "The high-scoring title candidate has no exact scholarly identifier", attempted, undefined, candidates);
    }
    return this.resolveExact(lookup, query, userAgent, attempted, candidates, "high_metadata");
  }

  async resolve(input: string): Promise<PaperResolution> {
    const query = parsePaperQuery(input);
    const userAgent = this.options.contactEmail
      ? `Paper2MD-Reader/0.1 (mailto:${this.options.contactEmail})`
      : "Paper2MD-Reader/0.1";
    if (query.kind === "title") return this.resolveTitle({ ...query, kind: "title" }, userAgent);
    if (query.kind === "url") {
      return problem(
        query,
        "QUERY_KIND_NOT_SUPPORTED",
        "This URL does not contain a recognized DOI, PMID, or PMCID and will not be fetched during identity resolution",
        []
      );
    }
    return this.resolveExact({ ...query, kind: query.kind }, query, userAgent);
  }
}
