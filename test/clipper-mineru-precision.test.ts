import { strToU8, Zip, zipSync, ZipPassThrough } from "fflate";
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

function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error("replacement strings must be equal length");
  const source = strToU8(from);
  const target = strToU8(to);
  const output = bytes.slice();
  for (let index = 0; index <= output.length - source.length; index += 1) {
    if (source.every((value, offset) => output[index + offset] === value)) output.set(target, index);
  }
  return output;
}

function asciiOffsets(bytes: Uint8Array, value: string): number[] {
  const source = strToU8(value);
  const offsets: number[] = [];
  for (let index = 0; index <= bytes.length - source.length; index += 1) {
    if (source.every((byte, offset) => bytes[index + offset] === byte)) offsets.push(index);
  }
  return offsets;
}

function replaceAsciiOccurrence(bytes: Uint8Array, from: string, to: string, occurrence: number): Uint8Array {
  if (from.length !== to.length) throw new Error("replacement strings must be equal length");
  const offset = asciiOffsets(bytes, from)[occurrence];
  if (offset === undefined) throw new Error(`missing ZIP string occurrence ${occurrence}: ${from}`);
  const output = bytes.slice();
  output.set(strToU8(to), offset);
  return output;
}

function endOfCentralDirectoryOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) return offset;
  }
  throw new Error("fixture is missing ZIP end-of-central-directory");
}

function insertUnlistedLocalRecord(base: Uint8Array, unlistedArchive: Uint8Array): Uint8Array {
  const baseEnd = endOfCentralDirectoryOffset(base);
  const unlistedEnd = endOfCentralDirectoryOffset(unlistedArchive);
  const baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const unlistedView = new DataView(unlistedArchive.buffer, unlistedArchive.byteOffset, unlistedArchive.byteLength);
  const centralOffset = baseView.getUint32(baseEnd + 16, true);
  const unlistedCentralOffset = unlistedView.getUint32(unlistedEnd + 16, true);
  const unlistedLocalRecord = unlistedArchive.subarray(0, unlistedCentralOffset);
  const output = new Uint8Array(base.byteLength + unlistedLocalRecord.byteLength);
  output.set(base.subarray(0, centralOffset), 0);
  output.set(unlistedLocalRecord, centralOffset);
  output.set(base.subarray(centralOffset), centralOffset + unlistedLocalRecord.byteLength);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(baseEnd + unlistedLocalRecord.byteLength + 16, centralOffset + unlistedLocalRecord.byteLength, true);
  return output;
}

async function streamingZip(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const archive = new Zip((error, chunk, final) => {
      if (error) { reject(error); return; }
      chunks.push(chunk);
      if (!final) return;
      const output = new Uint8Array(chunks.reduce((total, item) => total + item.byteLength, 0));
      let offset = 0;
      for (const item of chunks) { output.set(item, offset); offset += item.byteLength; }
      resolve(output);
    });
    for (const [name, data] of Object.entries(entries)) {
      const entry = new ZipPassThrough(name);
      archive.add(entry);
      entry.push(data, true);
    }
    archive.end();
  });
}

interface DescriptorRecord {
  localOffset: number;
  dataEnd: number;
}

function descriptorRecords(bytes: Uint8Array): {
  centralOffset: number;
  endOffset: number;
  records: DescriptorRecord[];
} {
  const endOffset = endOfCentralDirectoryOffset(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const records: DescriptorRecord[] = [];
  let centralEntryOffset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const flags = view.getUint16(centralEntryOffset + 8, true);
    if (!(flags & 0x08)) throw new Error("fixture entry does not use a data descriptor");
    const compressedSize = view.getUint32(centralEntryOffset + 20, true);
    const localOffset = view.getUint32(centralEntryOffset + 42, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    records.push({ localOffset, dataEnd: localOffset + 30 + localNameLength + localExtraLength + compressedSize });
    centralEntryOffset += 46
      + view.getUint16(centralEntryOffset + 28, true)
      + view.getUint16(centralEntryOffset + 30, true)
      + view.getUint16(centralEntryOffset + 32, true);
  }
  return { centralOffset, endOffset, records };
}

function stripDescriptorSignatures(bytes: Uint8Array): Uint8Array {
  const sourceView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { centralOffset, endOffset, records } = descriptorRecords(bytes);
  const signatures = records.map((record) => record.dataEnd).sort((left, right) => left - right);
  for (const offset of signatures) {
    if (sourceView.getUint32(offset, true) !== 0x08074b50) throw new Error("fixture descriptor is missing its signature");
  }
  const output = new Uint8Array(bytes.byteLength - signatures.length * 4);
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const signatureOffset of signatures) {
    const segment = bytes.subarray(sourceOffset, signatureOffset);
    output.set(segment, outputOffset);
    outputOffset += segment.byteLength;
    sourceOffset = signatureOffset + 4;
  }
  output.set(bytes.subarray(sourceOffset), outputOffset);

  const outputView = new DataView(output.buffer);
  const newCentralOffset = centralOffset - signatures.length * 4;
  let centralEntryOffset = newCentralOffset;
  for (const record of records) {
    const removedBeforeLocal = signatures.filter((offset) => offset < record.localOffset).length * 4;
    outputView.setUint32(centralEntryOffset + 42, record.localOffset - removedBeforeLocal, true);
    centralEntryOffset += 46
      + outputView.getUint16(centralEntryOffset + 28, true)
      + outputView.getUint16(centralEntryOffset + 30, true)
      + outputView.getUint16(centralEntryOffset + 32, true);
  }
  outputView.setUint32(endOffset - signatures.length * 4 + 16, newCentralOffset, true);
  return output;
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
    expect(result.archive).toEqual(archive);
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

  it("rejects approved hostnames on non-default HTTPS ports", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { batch_id: "batch_123", file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com:444/upload"] }
    }));
    await expect(runMineruPrecisionConversion(pdf(), "abcdefghijklmnop", () => undefined, { fetch: fetcher as typeof fetch }))
      .rejects.toThrow("未获授权的上传域名");
  });

  it("aborts a conversion before a network request when the page is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(runMineruPrecisionConversion(pdf(), "abcdefghijklmnop", () => undefined, {
      fetch: fetcher as typeof fetch,
      signal: controller.signal
    })).rejects.toThrow("已取消");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the request deadline active while an API response body stalls", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined)
    }), { status: 200 });
    const fetcher = vi.fn(async () => response);
    await expect(runMineruPrecisionConversion(pdf(), "abcdefghijklmnop", () => undefined, {
      fetch: fetcher as typeof fetch,
      timeoutMilliseconds: 10
    })).rejects.toThrow("超时");
  });

  it("rejects malformed PDFs before any network request", async () => {
    const fetcher = vi.fn();
    const file = new File([strToU8("not a pdf")], "bad.pdf", { type: "application/pdf" });
    await expect(runMineruPrecisionConversion(file, "abcdefghijklmnop", () => undefined, { fetch: fetcher as typeof fetch }))
      .rejects.toThrow("有效 PDF");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires one Markdown and unambiguous per-version content-list JSON", () => {
    const archive = zipSync({
      "result/full.md": strToU8("# one"),
      "result/other.md": strToU8("# two"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("Markdown 多于 1 个");
  });

  it("rejects archive traversal before exposing output", () => {
    const archive = zipSync({
      "../full.md": strToU8("# unsafe"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("不安全路径");
  });

  it("never rewrites URL-like or whitespace-suffixed entry names into allowed output paths", () => {
    for (const path of [
      "result/full.md ",
      "result/full.md?payload.exe",
      "result/full.md#/../../evil.exe",
      "result/full%2emd"
    ]) {
      const archive = zipSync({
        [path]: strToU8("# disguised"),
        "result/full_content_list.json": strToU8("[]")
      });
      expect(() => inspectMineruPrecisionArchive(archive), path).toThrow(/路径|不支持/);
    }
  });

  it("rejects local ZIP records that are not listed in the central directory", () => {
    const archive = insertUnlistedLocalRecord(
      validArchive(),
      zipSync({ "../../evil.exe": strToU8("unlisted") }, { level: 0 })
    );
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("未登记数据");
  });

  it("accepts valid ZIP32 data descriptors with and without signatures", async () => {
    const signed = await streamingZip({
      "result/full.md": strToU8("# streamed"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(inspectMineruPrecisionArchive(signed)).toMatchObject({ markdownCount: 1, jsonCount: 1 });
    expect(inspectMineruPrecisionArchive(stripDescriptorSignatures(signed))).toMatchObject({ markdownCount: 1, jsonCount: 1 });
  });

  it("accepts an unsigned descriptor whose CRC equals the optional signature marker", async () => {
    const signed = await streamingZip({
      "result/full.md": strToU8("# streamed"),
      "result/full_content_list.json": strToU8("[]"),
      "result/images/marker.png": new Uint8Array([0xac, 0x0a, 0x7a, 0xd5])
    });
    expect(inspectMineruPrecisionArchive(stripDescriptorSignatures(signed))).toMatchObject({ imageCount: 1 });
  });

  it("rejects a data descriptor that disagrees with its central directory", async () => {
    const signed = await streamingZip({
      "result/full.md": strToU8("# streamed"),
      "result/full_content_list.json": strToU8("[]")
    });
    const descriptorOffset = descriptorRecords(signed).records[0]!.dataEnd;
    const tampered = signed.slice();
    tampered[descriptorOffset + 4] ^= 1;
    expect(() => inspectMineruPrecisionArchive(tampered)).toThrow("数据描述符与中央目录冲突");
  });

  it("rejects duplicate raw ZIP entries before object-key overwrite", () => {
    const archive = replaceAscii(zipSync({
      "result/a.md": strToU8("# one"),
      "result/b.md": strToU8("# two"),
      "result/full_content_list.json": strToU8("[]")
    }), "result/b.md", "result/a.md");
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("重复或落盘冲突路径");
  });

  it("accepts simultaneous stable and v2 content lists emitted by MinerU", () => {
    const archive = zipSync({
      "result/full.md": strToU8("# one"),
      "result/full_content_list.json": strToU8("[]"),
      "result/full_content_list_v2.json": strToU8("[]")
    });
    expect(inspectMineruPrecisionArchive(archive)).toEqual({
      fileCount: 3,
      markdownCount: 1,
      jsonCount: 2,
      imageCount: 0
    });
  });

  it("rejects missing or duplicate content-list variants with safe count diagnostics", () => {
    const missing = zipSync({ "result/full.md": strToU8("# one") });
    expect(() => inspectMineruPrecisionArchive(missing)).toThrow("缺少 content-list JSON");

    const duplicateStable = zipSync({
      "result/full.md": strToU8("# one"),
      "result/a_content_list.json": strToU8("[]"),
      "result/b_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(duplicateStable)).toThrow("稳定版 2、v2 0");

    const duplicateV2 = zipSync({
      "result/full.md": strToU8("# one"),
      "result/a_content_list_v2.json": strToU8("[]"),
      "result/b_content_list_v2.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(duplicateV2)).toThrow("稳定版 0、v2 2");
  });

  it("reports only bounded structural counts when validation fails", () => {
    const archive = zipSync({
      "result/private-draft.md": strToU8("CONFIDENTIAL_SENTINEL"),
      "result/secret-notes.md": strToU8("# second"),
      "result/a_content_list.json": strToU8("[]"),
      "result/b_content_list.json": strToU8("[]"),
      "result/layout.json": strToU8("{}"),
      "result/images/sensitive.png": new Uint8Array([1])
    });
    let message = "";
    try { inspectMineruPrecisionArchive(archive); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("Markdown 多于 1 个");
    expect(message).toContain("同一版本的 content-list 候选重复");
    expect(message).toContain("Markdown 2、JSON 3、图片 1、content-list 候选 2（稳定版 2、v2 0）");
    expect(message).toContain("结果未下载");
    expect(message).not.toMatch(/private-draft|secret-notes|sensitive|CONFIDENTIAL_SENTINEL/);
  });

  it("accepts explicit empty directory records without counting or rewriting them", () => {
    const archive = zipSync({
      "result/": new Uint8Array(),
      "result/images/": new Uint8Array(),
      "result/full.md": strToU8("# one"),
      "result/full_content_list.json": strToU8("[]"),
      "result/images/figure.png": new Uint8Array([137, 80, 78, 71])
    }, { level: 0 });
    expect(inspectMineruPrecisionArchive(archive)).toEqual({
      fileCount: 3,
      markdownCount: 1,
      jsonCount: 1,
      imageCount: 1
    });
  });

  it("rejects directory records that carry payload bytes", () => {
    const archive = zipSync({
      "result/": strToU8("unexpected"),
      "result/full.md": strToU8("# one"),
      "result/full_content_list.json": strToU8("[]")
    }, { level: 0 });
    expect(() => inspectMineruPrecisionArchive(archive)).toThrow("目录条目含异常数据");
  });

  it("rejects a local filename that disagrees with the central directory", () => {
    const archive = zipSync({
      "result/full.md": strToU8("# one"),
      "result/full_content_list.json": strToU8("[]")
    }, { level: 0 });
    expect(asciiOffsets(archive, "result/full.md")).toHaveLength(2);
    const tampered = replaceAsciiOccurrence(archive, "result/full.md", "result/fall.md", 0);
    expect(() => inspectMineruPrecisionArchive(tampered)).toThrow("本地文件头与中央目录冲突");
  });

  it("rejects trailing bytes after the end-of-central-directory record", () => {
    const archive = validArchive();
    const tampered = new Uint8Array(archive.byteLength + 1);
    tampered.set(archive);
    tampered[tampered.length - 1] = 1;
    expect(() => inspectMineruPrecisionArchive(tampered)).toThrow("中央目录");
  });

  it("checks each extracted payload against the ZIP CRC", () => {
    const marker = "# Parsed paper\n";
    const archive = zipSync({
      "result/full.md": strToU8(marker),
      "result/full_content_list.json": strToU8("[]")
    }, { level: 0 });
    const offsets = asciiOffsets(archive, marker);
    expect(offsets).toHaveLength(1);
    const tampered = archive.slice();
    tampered[offsets[0]!] ^= 1;
    expect(() => inspectMineruPrecisionArchive(tampered)).toThrow("CRC");
  });

  it("rejects case-insensitive and Unicode-normalized landing-path collisions", () => {
    const caseCollision = zipSync({
      "result/full.md": strToU8("# one"),
      "RESULT/FULL.MD": strToU8("# two"),
      "result/full_content_list.json": strToU8("[]")
    });
    expect(() => inspectMineruPrecisionArchive(caseCollision)).toThrow("落盘冲突路径");

    const unicodeCollision = zipSync({
      "result/full.md": strToU8("# one"),
      "result/full_content_list.json": strToU8("[]"),
      "result/images/Fig.png": new Uint8Array([1]),
      "result/images/Ｆｉｇ.png": new Uint8Array([2])
    });
    expect(() => inspectMineruPrecisionArchive(unicodeCollision)).toThrow("落盘冲突路径");
  });

  it("rejects Windows device aliases and trailing-dot path aliases", () => {
    for (const path of ["result/images/CON.png", "result/images/figure.png."]) {
      const archive = zipSync({
        "result/full.md": strToU8("# one"),
        "result/full_content_list.json": strToU8("[]"),
        [path]: new Uint8Array([1])
      });
      expect(() => inspectMineruPrecisionArchive(archive), path).toThrow("不兼容本地文件系统");
    }
  });
});
