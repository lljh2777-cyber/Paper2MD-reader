import { describe, expect, it, vi } from "vitest";
import { loadProcessingServiceConfig } from "../apps/processing-service/src/config";
import { IngestManager } from "../apps/processing-service/src/ingest-manager";
import { publishClippingPackage } from "../apps/processing-service/src/clipping-package-publisher";
import type { PaperResolution } from "../packages/agent-contracts/src/index";

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

  it("fails closed when resolution has no supported session-free PMC HTML", async () => {
    const unsupported: PaperResolution = {
      ...resolution,
      full_text_sources: [{ ...resolution.full_text_sources[0], provider: "publisher", url: "https://journal.example.org/article" }]
    };
    const manager = new IngestManager(config(), { resolve: async () => unsupported }, { prepareStorage: async () => undefined });
    const created = manager.create("PMCID: PMC3531190");
    const completed = await terminalJob(manager, created.job_id);
    expect(completed.state).toBe("needs_attention");
    expect(completed.problem?.code).toBe("CLIPPER_UNSUPPORTED");
  });

  it("does not publish implausibly short or non-HTML provider output", async () => {
    const fetchMock = vi.fn(async () => new Response("not an article", { headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;
    const publish = vi.fn();
    const manager = new IngestManager(config(), { resolve: async () => resolution }, {
      fetch: fetchMock,
      publish,
      prepareStorage: async () => undefined
    });
    const completed = await terminalJob(manager, manager.create("PMCID: PMC3531190").job_id);
    expect(completed.state).toBe("failed");
    expect(completed.problem?.code).toBe("EXTRACTION_FAILED");
    expect(publish).not.toHaveBeenCalled();
  });
});
