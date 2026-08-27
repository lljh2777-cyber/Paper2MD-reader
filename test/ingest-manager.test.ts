import { describe, expect, it, vi } from "vitest";
import { loadProcessingServiceConfig } from "../apps/processing-service/src/config";
import { IngestManager } from "../apps/processing-service/src/ingest-manager";
import { publishClippingPackage } from "../apps/processing-service/src/clipping-package-publisher";
import type { PaperResolution } from "../packages/agent-contracts/src/index";
import type { SafeAcquisitionFetchOptions } from "../apps/processing-service/src/safe-acquisition-fetch";

const htmlSource = "https://pmc.ncbi.nlm.nih.gov/articles/PMC3531190/";
const resolution: PaperResolution = {
  status: "resolved",
  query: { kind: "pmcid", value: "PMC3531190", original: "PMCID: PMC3531190" },
  match: {
    confidence: "exact_identifier",
    identity: {
      title: "A deterministic PMC paper",
      authors: ["Ada Researcher"],
      year: 2026,
      identifiers: { pmcid: "PMC3531190", pmid: "12345678" }
    }
  },
  full_text_sources: [{
    source_id: "pmc-html-pmc3531190",
    provider: "europe_pmc",
    format: "html",
    url: htmlSource,
    access: "open_access",
    acquisition_route: "clipper_core",
    priority: 20,
    requires_domain_permission: false,
    requires_browser_session: false
  }],
  recommended_source_id: "pmc-html-pmc3531190",
  attempted_sources: [{ provider: "europe_pmc", locator: "pmcid:PMC3531190", outcome: "available" }]
};

function articleHtml(): string {
  return `<!doctype html><html lang="en"><head><title>A deterministic PMC paper</title></head><body>
    <article><h1>A deterministic PMC paper</h1><h2>Abstract</h2><p>${"Evidence sentence. ".repeat(40)}</p>
    <figure><img src="https://cdn.ncbi.nlm.nih.gov/pmc/blobs/figure.png" alt="Figure 1"><figcaption>Figure 1. Verified result.</figcaption></figure>
    <h2>Methods</h2><p>${"Method sentence. ".repeat(40)}</p></article></body></html>`;
}

async function terminalJob(manager: IngestManager, id: string) {
  for (let count = 0; count < 200; count += 1) {
    const job = manager.get(id)!;
    if (["ready", "needs_attention", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for ingest test job");
}

function config() {
  return loadProcessingServiceConfig({
    PAPER2MD_DATA_ROOT: "service-qa-data",
    PAPER2MD_MAX_ACTIVE_JOBS: "2",
    PAPER2MD_RESOLVER_TIMEOUT_MS: "1000"
  });
}

function acquired(fetchMock: typeof fetch) {
  return async (url: string, options: SafeAcquisitionFetchOptions) => {
    const response = await fetchMock(url);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (!options.accept.includes(mime)) throw new Error("unsupported MIME");
    return { finalUrl: url, mime, bytes: new Uint8Array(await response.arrayBuffer()) };
  };
}

describe("deterministic paper ingest orchestration", () => {
  it("publishes a staged PMC clipping and returns an opaque Reader deep link", async () => {
    const resolver = { resolve: vi.fn(async () => resolution) };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url === htmlSource
        ? new Response(articleHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    }) as unknown as typeof fetch;
    const publish = vi.fn(async (input: Parameters<typeof publishClippingPackage>[0]) => {
      expect(input.files.has("article.md")).toBe(true);
      expect(input.files.has("images/figure-0001.png")).toBe(true);
      input.onValidated?.();
      return {
        packageId: input.packageId,
        label: input.label,
        files: [...input.files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: "0".repeat(64) }))
      };
    });
    const manager = new IngestManager(config(), resolver, {
      fetch: fetchMock,
      acquire: acquired(fetchMock),
      publish,
      prepareStorage: async () => undefined
    });
    const created = manager.create("PMCID: PMC3531190");
    expect(created.state).toBe("queued");

    const completed = await terminalJob(manager, created.job_id);
    expect(completed).toMatchObject({ state: "ready", package_id: expect.any(String) });
    expect(completed.reader_url).toBe(`http://127.0.0.1:4174/reader/${completed.package_id}`);
    expect(manager.getPackage(completed.package_id!)).toMatchObject({ packageId: completed.package_id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an extension handoff instead of fetching a browser-session source", async () => {
    const unsupported: PaperResolution = {
      ...resolution,
      full_text_sources: [{
        ...resolution.full_text_sources[0],
        provider: "publisher",
        url: "https://journal.example.org/article",
        acquisition_route: "clipper_extension",
        requires_browser_session: true,
        requires_domain_permission: true
      }]
    };
    const manager = new IngestManager(config(), { resolve: async () => unsupported }, { prepareStorage: async () => undefined });
    const created = manager.create("PMCID: PMC3531190");
    const completed = await terminalJob(manager, created.job_id);
    expect(completed.state).toBe("needs_attention");
    expect(completed.problem?.code).toBe("LOGIN_REQUIRED");
  });

  it("does not publish implausibly short or non-HTML provider output", async () => {
    const fetchMock = vi.fn(async () => new Response("not an article", { headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;
    const publish = vi.fn();
    const manager = new IngestManager(config(), { resolve: async () => resolution }, {
      fetch: fetchMock,
      acquire: acquired(fetchMock),
      publish,
      prepareStorage: async () => undefined
    });
    const completed = await terminalJob(manager, manager.create("PMCID: PMC3531190").job_id);
    expect(completed.state).toBe("failed");
    expect(completed.problem?.code).toBe("EXTRACTION_FAILED");
    expect(publish).not.toHaveBeenCalled();
  });

  it("routes a verified open PDF through the existing MinerU validation publisher", async () => {
    const pdfResolution: PaperResolution = {
      ...resolution,
      full_text_sources: [{
        ...resolution.full_text_sources[0],
        source_id: "oa-pdf",
        provider: "repository",
        format: "pdf",
        url: "https://repository.example.org/paper.pdf",
        acquisition_route: "mineru",
        priority: 50
      }]
    };
    const processPdf = vi.fn(async () => ({ packageId: "mineru-package-1", label: "Paper", files: [] }));
    const manager = new IngestManager(config(), { resolve: async () => pdfResolution }, {
      acquire: async (url) => ({
        finalUrl: url,
        mime: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7 deterministic fixture")
      }),
      processPdf,
      prepareStorage: async () => undefined
    });
    const completed = await terminalJob(manager, manager.create("PMCID: PMC3531190").job_id);
    expect(completed).toMatchObject({ state: "ready", package_id: "mineru-package-1" });
    expect(processPdf).toHaveBeenCalledOnce();
  });

  it("converts verified PMC JATS XML deterministically before staged publication", async () => {
    const xmlResolution: PaperResolution = {
      ...resolution,
      full_text_sources: [{
        ...resolution.full_text_sources[0],
        source_id: "pmc-xml",
        format: "xml",
        url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC3531190/fullTextXML",
        priority: 10
      }]
    };
    const xml = `<?xml version="1.0"?><article xml:lang="en"><front><article-meta><title-group><article-title>A deterministic PMC paper</article-title></title-group><abstract><p>${"Abstract evidence. ".repeat(20)}</p></abstract></article-meta></front><body><sec><title>Results</title><p>${"Result evidence. ".repeat(40)}</p></sec></body></article>`;
    const publish = vi.fn(async (input: Parameters<typeof publishClippingPackage>[0]) => {
      expect(new TextDecoder().decode(input.files.get("article.md"))).toContain("## Results");
      input.onValidated?.();
      return { packageId: input.packageId, label: input.label, files: [] };
    });
    const manager = new IngestManager(config(), { resolve: async () => xmlResolution }, {
      acquire: async (url) => ({ finalUrl: url, mime: "application/xml", bytes: new TextEncoder().encode(xml) }),
      publish,
      prepareStorage: async () => undefined
    });
    const completed = await terminalJob(manager, manager.create("PMCID: PMC3531190").job_id);
    expect(completed.state).toBe("ready");
    expect(publish).toHaveBeenCalledOnce();
  });
});
