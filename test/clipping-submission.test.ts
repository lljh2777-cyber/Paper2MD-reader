import { describe, expect, it, vi } from "vitest";
import {
  buildClippingSubmissionFormData,
  processingServicePermissionPattern,
  publishClippingSubmission as publishFromExtension
} from "../apps/clipper-extension/src/processing-bridge";
import {
  parseClippingSubmission,
  publishClippingSubmission as publishFromService
} from "../apps/processing-service/src/clipping-submission";
import { loadProcessingServiceConfig } from "../apps/processing-service/src/config";
import type { ExtractedPaperPage, LocalizedImage } from "../packages/clipper-core/src/index";

const page: ExtractedPaperPage = {
  title: "Direct Clipper bridge paper",
  author: "A. Researcher",
  published: "2026",
  description: "A deterministic clipping submission.",
  sourceUrl: "https://journal.example.org/paper",
  language: "en",
  wordCount: 500,
  markdown: `# Direct Clipper bridge paper\n\n## Results\n\n${"Evidence sentence. ".repeat(30)}\n\n![Figure 1](https://cdn.example.org/figure.png)\n\nFigure 1. Verified result.`
};
const sourceHtml = `<!doctype html><html><head><title>Direct Clipper bridge paper</title></head><body><article>${"Evidence sentence. ".repeat(30)}</article></body></html>`;
const images = new Map<string, LocalizedImage>([["https://cdn.example.org/figure.png", {
  url: "https://cdn.example.org/figure.png",
  path: "images/figure-0001.png",
  mime: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71])
}]]);

function submission(): FormData {
  return buildClippingSubmissionFormData({
    page,
    sourceHtml,
    localizedImages: images,
    createdAt: "2026-08-27T00:00:00.000Z",
    extraction: { engine: "defuddle", engineVersion: "0.19.3", useAsyncFallback: false }
  });
}

describe("direct Clipper to processing-service bridge", () => {
  it("requests the Chromium loopback host pattern while keeping the service port fixed", () => {
    expect(processingServicePermissionPattern("http://127.0.0.1:8787")).toBe("http://127.0.0.1/*");
    expect(() => processingServicePermissionPattern("http://127.0.0.1:9999")).toThrow("fixed loopback origin");
  });

  it("round-trips only the declared structured parts and reconstructs localized inputs", async () => {
    const parsed = await parseClippingSubmission(submission());
    expect(parsed.page).toEqual(page);
    expect(new TextDecoder().decode(parsed.sourceHtml)).toBe(sourceHtml);
    expect(parsed.localizedImages.get("https://cdn.example.org/figure.png")).toMatchObject({
      path: "images/figure-0001.png",
      mime: "image/png"
    });
  });

  it("fails closed on undeclared fields and unsupported extraction metadata", async () => {
    const extra = submission();
    extra.set("unexpected", "data");
    await expect(parseClippingSubmission(extra)).rejects.toThrow("unsupported parts");

    const altered = submission();
    const metadata = JSON.parse(String(altered.get("metadata")));
    metadata.extraction.useAsyncFallback = true;
    altered.set("metadata", JSON.stringify(metadata));
    await expect(parseClippingSubmission(altered)).rejects.toThrow("extraction contract");

    const duplicated = submission();
    const duplicatedMetadata = JSON.parse(String(duplicated.get("metadata")));
    duplicatedMetadata.images.push({
      ...duplicatedMetadata.images[0],
      field: "image-0002",
      path: "images/figure-0002.png"
    });
    duplicated.set("metadata", JSON.stringify(duplicatedMetadata));
    duplicated.set("image-0002", new Blob([new Uint8Array([1])], { type: "image/png" }), "figure-0002.png");
    await expect(parseClippingSubmission(duplicated)).rejects.toThrow("duplicated");
  });

  it("rebuilds the package on the service and returns an opaque Reader deep link", async () => {
    const publish = vi.fn(async (input) => {
      expect(input.files.has("article.md")).toBe(true);
      expect(input.files.has("_clipping/manifest.json")).toBe(true);
      expect(input.files.has("images/figure-0001.png")).toBe(true);
      expect(new TextDecoder().decode(input.sourceHtml)).toBe(sourceHtml);
      return {
        packageId: input.packageId,
        label: input.label,
        files: [...input.files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: "0".repeat(64) }))
      };
    });
    const result = await publishFromService(submission(), loadProcessingServiceConfig(), {
      publish,
      prepareStorage: async () => undefined
    });
    expect(result.package_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.reader_url).toBe(`http://127.0.0.1:4174/reader/${result.package_id}`);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("validates service responses before opening a Reader URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8787/api/v1/clippings");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"a".repeat(48)}`);
      return Response.json({
        package_id: "package-123",
        reader_url: "http://127.0.0.1:4174/reader/package-123"
      });
    });
    await expect(publishFromExtension(submission(), { fetch: fetchMock, token: "a".repeat(48) })).resolves.toEqual({
      packageId: "package-123",
      readerUrl: "http://127.0.0.1:4174/reader/package-123"
    });
    await expect(publishFromExtension(submission(), {
      fetch: async () => Response.json({ package_id: "package-123", reader_url: "http://evil.example/reader/package-123" }),
      token: "a".repeat(48)
    })).rejects.toThrow("unsafe Reader URL");
  });
});
