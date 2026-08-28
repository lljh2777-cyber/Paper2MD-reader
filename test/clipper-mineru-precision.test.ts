import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MINERU_PRECISION_PERMISSION_PATTERNS,
  inspectMineruPrecisionArchive,
  runMineruPrecisionConversion,
  validateMineruPrecisionToken
} from "../apps/clipper-extension/src/mineru-precision-client";

function pdf(name = "example.pdf"): File {
  return new File([strToU8("%PDF-1.7\nfixture")], name, { type: "application/pdf" });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function validArchive(): Uint8Array {
  return zipSync({
    "result/full.md": strToU8("# Parsed paper\n"),
    "result/full_content_list.json": strToU8(JSON.stringify([{ type: "text", text: "Parsed paper" }])),
    "result/layout.json": strToU8("{}"),
    "result/images/figure.png": new Uint8Array([137, 80, 78, 71])
  });
}

describe("After-MinerU extension precision conversion", () => {
  it("uses only the three documented MinerU transfer origins", () => {
    expect(MINERU_PRECISION_PERMISSION_PATTERNS).toEqual([
      "https://mineru.net/*",
      "https://mineru.oss-cn-shanghai.aliyuncs.com/*",
      "https://cdn-mineru.openxlab.org.cn/*"
    ]);
  });

  it("validates temporary token syntax without normalizing internal content", () => {
    expect(validateMineruPrecisionToken("  abcdefghijklmnop  ")).toBe("abcdefghijklmnop");
    expect(() => validateMineruPrecisionToken("short")).toThrow("Token");
    expect(() => validateMineruPrecisionToken("abcdefghijklmnop\nsecret")).toThrow("Token");
  });

  it("runs allocate, raw PUT, poll, download and archive validation without sending Token to object storage", async () => {
    const archive = validArchive();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/v4/file-urls/batch")) return jsonResponse({
        code: 0,
        data: {
          batch_id: "batch_123",
          file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/file?signature=one"]
        }
      });
      if (url.includes("aliyuncs.com")) return new Response(null, { status: 200 });
      if (url.includes("/extract-results/batch/")) return jsonResponse({
        code: 0,
        data: {
          extract_result: [{ state: "done", full_zip_url: "https://cdn-mineru.openxlab.org.cn/pdf/result.zip" }]
        }
      });
      if (url.includes("cdn-mineru.openxlab.org.cn")) return new Response(
        archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
        {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(archive.byteLength) }
        }
      );
      throw new Error(`Unexpected request: ${url}`);
    });
    const progress: string[] = [];

    const result = await runMineruPrecisionConversion(
      pdf("Research Paper.pdf"),
      "abcdefghijklmnop",
      (event) => progress.push(event.stage),
      { fetch: fetcher as typeof fetch, pollDelayMilliseconds: 0 }
    );

    expect(result).toMatchObject({
      archiveName: "Research-Paper.mineru.zip",
      fileCount: 4,
      markdownCount: 1,
      jsonCount: 2,
      imageCount: 1
    });
    expect(progress).toEqual(["allocate", "upload", "download", "validate"]);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer abcdefghijklmnop" });
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(calls[1]?.init?.headers).toBeUndefined();
    expect(calls[1]?.init?.body).toBeInstanceOf(Blob);
    expect((calls[1]?.init?.body as Blob).type).toBe("");
    expect((calls[1]?.init?.body as Blob).size).toBe(pdf("Research Paper.pdf").size);
    expect(JSON.stringify(calls[1]?.init)).not.toContain("abcdefghijklmnop");
    expect(calls.every((call) => call.init?.credentials === "omit" && call.init?.redirect === "error")).toBe(true);
  });

  it("fails closed when MinerU returns an unapproved signed-upload origin", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { batch_id: "batch_123", file_urls: ["https://attacker.example/upload"] }
    }));
    await expect(runMineruPrecisionConversion(pdf(), "abcdefghijklmnop", () => undefined, { fetch: fetcher as typeof fetch }))
      .rejects.toThrow("未获授权的上传域名");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed PDFs before any network request", async () => {
    const fetcher = vi.fn();
    const file = new File([strToU8("not a pdf")], "bad.pdf", { type: "application/pdf" });
    await expect(runMineruPrecisionConversion(file, "abcdefghijklmnop", () => undefined, { fetch: fetcher as typeof fetch }))
      .rejects.toThrow("有效 PDF");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires one Markdown and one unambiguous content-list JSON", () => {
    const archive = zipSync({
      "result/full.md": strToU8("# one"),
      "result/other.md": strToU8("# two"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("唯一 Markdown");
  });

  it("rejects archive traversal before exposing output", () => {
    const archive = zipSync({
      "../full.md": strToU8("# unsafe"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("不安全路径");
  });
});
