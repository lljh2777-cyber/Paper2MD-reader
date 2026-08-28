import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MineruPrecisionApiClient,
  mineruUploadHeaders
} from "../apps/processing-service/src/mineru-api-client";
import { inspectMineruArchive } from "../apps/processing-service/src/remote-mineru-workflow";

function resultArchive(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "paper/full.md": strToU8("# Paper\n\nA sufficiently structured extraction result.\n"),
    "paper/paper_content_list.json": strToU8(JSON.stringify([{ type: "text", text: "Paper", page_idx: 0 }])),
    "paper/images/figure-1.png": new Uint8Array([137, 80, 78, 71, 1]),
    ...extra
  });
}

describe("remote MinerU archive boundary", () => {
  it("keeps pre-signed MinerU uploads free of a Content-Type header", () => {
    expect(mineruUploadHeaders(1024)).toEqual({ "Content-Length": "1024" });
    expect(mineruUploadHeaders(1024)).not.toHaveProperty("Content-Type");
  });

  it("accepts only the expected Markdown, content-list, and raster image outputs", () => {
    const entries = inspectMineruArchive(resultArchive());
    expect(Object.keys(entries).sort()).toEqual([
      "paper/full.md",
      "paper/images/figure-1.png",
      "paper/paper_content_list.json"
    ]);
  });

  it("fails closed on traversal paths and unsupported executable output", () => {
    expect(() => inspectMineruArchive(resultArchive({ "../article.md": strToU8("# Escape") }))).toThrow();
    expect(() => inspectMineruArchive(resultArchive({ "paper/run.exe": new Uint8Array([1]) }))).toThrow(
      "unsupported output path"
    );
  });

  it("requires exactly one Markdown and one valid content-list JSON", () => {
    expect(() => inspectMineruArchive(resultArchive({ "paper/second.md": strToU8("# Duplicate") }))).toThrow(
      "one Markdown"
    );
    const malformed = zipSync({
      "full.md": strToU8("# Paper"),
      "paper_content_list.json": strToU8("not-json")
    });
    expect(() => inspectMineruArchive(malformed)).toThrow("invalid structured JSON");
  });

  it("counts directory records toward the 1,024-entry archive limit", () => {
    const directories = Object.fromEntries(Array.from({ length: 1_100 }, (_value, index) => [
      `paper/empty-${index}/`,
      new Uint8Array()
    ]));
    expect(() => inspectMineruArchive(resultArchive(directories))).toThrow("exceeds safe limits");
  });
});

describe("MinerU precision API envelope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps authentication in the request header and returns opaque task state", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({
      code: 0,
      data: {
        extract_result: [{
          task_id: "task_123",
          state: "running",
          extract_progress: { extracted_pages: 3, total_pages: 12 }
        }]
      }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = "test_token_1234567890";
    const client = new MineruPrecisionApiClient(token);

    await expect(client.getBatch("batch_123")).resolves.toEqual([{
      taskId: "task_123",
      state: "running",
      progress: { extractedPages: 3, totalPages: 12 }
    }]);
    expect(capturedInit?.headers).toMatchObject({ Authorization: `Bearer ${token}`, source: "paper2md-desktop" });
    expect(JSON.stringify(await client.getBatch("batch_123"))).not.toContain(token);
  });

  it("maps quota failures to bounded user-facing errors without provider response text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: -60018,
      msg: "provider detail that must not be surfaced",
      data: {}
    }), { status: 200 })));
    const client = new MineruPrecisionApiClient("test_token_1234567890");
    await expect(client.getBatch("batch_123")).rejects.toMatchObject({
      code: "-60018",
      message: "The MinerU account has insufficient quota for this extraction"
    });
  });
});
