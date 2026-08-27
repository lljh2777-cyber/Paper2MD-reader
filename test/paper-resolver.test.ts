import { describe, expect, it, vi } from "vitest";
import {
  metadataRecordsConflict,
  rankFullTextSources,
  titleTokenSimilarity,
  type FullTextSource
} from "../packages/agent-contracts/src/index";
import { PaperResolver } from "../apps/processing-service/src/paper-resolver";

const doi = "10.1093/nar/gks1195";

function europe(overrides: Record<string, unknown> = {}): unknown {
  return {
    hitCount: 1,
    resultList: {
      result: [{
        id: "23193287",
        pmid: "23193287",
        pmcid: "PMC3531190",
        doi,
        title: "GenBank.",
        pubYear: "2013",
        journalTitle: "Nucleic Acids Research",
        authorList: { author: [{ fullName: "Benson DA" }, { fullName: "Cavanaugh M" }] },
        isOpenAccess: "Y",
        fullTextUrlList: {
          fullTextUrl: [
            { availabilityCode: "S", documentStyle: "doi", url: `https://doi.org/${doi}` },
            { availabilityCode: "OA", documentStyle: "html", url: "https://europepmc.org/articles/PMC3531190" },
            { availabilityCode: "OA", documentStyle: "pdf", url: "https://europepmc.org/articles/PMC3531190?pdf=render" }
          ]
        },
        ...overrides
      }]
    }
  };
}

function crossref(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: "ok",
    message: {
      DOI: doi,
      title: ["GenBank"],
      author: [{ given: "Dennis A.", family: "Benson" }],
      issued: { "date-parts": [[2013, 1, 1]] },
      "container-title": ["Nucleic Acids Research"],
      ...overrides
    }
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(status === 404 ? undefined : JSON.stringify(value), {
    status,
    headers: status === 404 ? undefined : { "Content-Type": "application/json" }
  });
}

function resolverFetch(input: { europe?: unknown; crossref?: unknown; unpaywall?: unknown; failures?: Set<string> }) {
  return vi.fn(async (request: string | URL | Request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    const provider = url.hostname.includes("europepmc") || url.hostname.includes("ebi.ac.uk")
      ? "europe"
      : url.hostname === "api.crossref.org"
        ? "crossref"
        : "unpaywall";
    if (input.failures?.has(provider)) throw new Error(`${provider} unavailable`);
    const value = input[provider];
    return value === undefined ? response({}, 404) : response(value);
  }) as unknown as typeof fetch;
}

describe("deterministic paper identity resolution", () => {
  it("resolves a PMCID exactly and prefers open XML over HTML and PDF", async () => {
    const fetchMock = resolverFetch({ europe: europe() });
    const result = await new PaperResolver({ fetch: fetchMock }).resolve("PMCID: PMC3531190");

    expect(result.status).toBe("resolved");
    expect(result.match).toMatchObject({
      confidence: "exact_identifier",
      identity: { title: "GenBank.", identifiers: { pmid: "23193287", pmcid: "PMC3531190", doi } }
    });
    expect(result.full_text_sources.map((source) => source.format)).toEqual(["xml", "html", "pdf"]);
    expect(result.recommended_source_id).toBe("epmc-xml-pmc3531190");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges exact DOI metadata and adds only safe Unpaywall OA locations", async () => {
    const fetchMock = resolverFetch({
      europe: europe(),
      crossref: crossref(),
      unpaywall: {
        doi,
        is_oa: true,
        best_oa_location: {
          host_type: "publisher",
          url_for_landing_page: "https://journal.example.org/open/genbank",
          url_for_pdf: "https://journal.example.org/open/genbank.pdf",
          license: "cc-by",
          version: "publishedVersion"
        },
        oa_locations: [{
          host_type: "repository",
          url_for_landing_page: "https://127.0.0.1/private",
          url_for_pdf: "https://repository.example.edu/genbank.pdf",
          license: "cc-by"
        }]
      }
    });
    const result = await new PaperResolver({ fetch: fetchMock, contactEmail: "maintainer@example.org" }).resolve(`DOI: ${doi}`);

    expect(result.status).toBe("resolved");
    expect(result.match?.identity.authors[0]).toContain("Benson");
    expect(result.full_text_sources.some((source) => source.url.includes("127.0.0.1"))).toBe(false);
    expect(result.full_text_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "publisher", format: "html", acquisition_route: "clipper_core", license: "cc-by" }),
      expect.objectContaining({ provider: "repository", format: "pdf", acquisition_route: "mineru" })
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns structured intervention when identity is exact but full text is not verified", async () => {
    const fetchMock = resolverFetch({
      europe: europe({
        isOpenAccess: "N",
        fullTextUrlList: { fullTextUrl: [{ availabilityCode: "S", documentStyle: "doi", url: `https://doi.org/${doi}` }] }
      })
    });
    const result = await new PaperResolver({ fetch: fetchMock }).resolve("PMID: 23193287");

    expect(result.status).toBe("needs_attention");
    expect(result.match?.confidence).toBe("exact_identifier");
    expect(result.problem).toMatchObject({
      code: "FULL_TEXT_NOT_AVAILABLE",
      next_steps: expect.arrayContaining([expect.stringContaining("Clipper"), expect.stringContaining("PDF")])
    });
  });

  it("stops when exact-identifier providers disagree on core metadata", async () => {
    const fetchMock = resolverFetch({
      europe: europe(),
      crossref: crossref({ title: ["An unrelated clinical trial"], issued: { "date-parts": [[2025]] } })
    });
    const result = await new PaperResolver({ fetch: fetchMock }).resolve(doi);

    expect(result.status).toBe("needs_attention");
    expect(result.problem?.code).toBe("AMBIGUOUS_MATCH");
    expect(result.match).toBeUndefined();
  });

  it("distinguishes no match, provider outage, and unsupported query kinds", async () => {
    const notFound = await new PaperResolver({ fetch: resolverFetch({}) }).resolve("PMID: 999999999");
    expect(notFound.problem?.code).toBe("PAPER_NOT_FOUND");

    const unavailable = await new PaperResolver({ fetch: resolverFetch({ failures: new Set(["europe"]) }) }).resolve("PMID: 23193287");
    expect(unavailable.problem?.code).toBe("METADATA_SERVICE_UNAVAILABLE");

    const fetchMock = resolverFetch({ europe: europe() });
    const unsupported = await new PaperResolver({ fetch: fetchMock }).resolve("A paper title not yet supported");
    expect(unsupported.problem?.code).toBe("QUERY_KIND_NOT_SUPPORTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("paper resolution confidence and source ranking", () => {
  it("normalizes punctuation while retaining a strict conflict threshold", () => {
    expect(titleTokenSimilarity("Single-cell RNA sequencing: an atlas", "Single cell RNA sequencing — an atlas.")).toBe(1);
    expect(metadataRecordsConflict({ title: "Same title", year: 2020 }, { title: "Same title", year: 2022 })).toBe(true);
    expect(metadataRecordsConflict({ title: "Completely different", year: 2020 }, { title: "Unrelated work", year: 2020 })).toBe(true);
  });

  it("deduplicates URLs and preserves deterministic priority order", () => {
    const base: Omit<FullTextSource, "source_id" | "priority" | "format" | "url"> = {
      provider: "europe_pmc",
      access: "open_access",
      acquisition_route: "clipper_core",
      requires_domain_permission: false,
      requires_browser_session: false
    };
    const ranked = rankFullTextSources([
      { ...base, source_id: "pdf", priority: 50, format: "pdf", url: "https://example.org/paper.pdf", acquisition_route: "mineru" },
      { ...base, source_id: "html", priority: 20, format: "html", url: "https://example.org/paper" },
      { ...base, source_id: "duplicate", priority: 30, format: "html", url: "https://example.org/paper" }
    ]);
    expect(ranked.map((source) => source.source_id)).toEqual(["html", "pdf"]);
  });
});
