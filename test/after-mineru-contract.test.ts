import { describe, expect, it } from "vitest";
import { zipSync, type Zippable } from "fflate";
import {
  AFTER_MINERU_SOURCE_ARCHIVE_LIMITS,
  extractValidatedZipEntries,
  isSafeAfterMinerUPath,
  sha256Bytes,
  sha256Utf8
} from "../packages/after-mineru-contract/src/index";

describe("After-MinerU shared contract primitives", () => {
  it("uses a deterministic browser-safe SHA-256 implementation", () => {
    expect(sha256Bytes(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Utf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("rejects traversal, normalization, and Windows landing conflicts", () => {
    expect(isSafeAfterMinerUPath("source/full.md")).toBe(true);
    expect(isSafeAfterMinerUPath("../full.md")).toBe(false);
    expect(isSafeAfterMinerUPath("source\\full.md")).toBe(false);
    expect(isSafeAfterMinerUPath("source/CON.txt")).toBe(false);
    expect(isSafeAfterMinerUPath("source/full.md ")).toBe(false);
    expect(isSafeAfterMinerUPath("source/__proto__/full.md")).toBe(false);
    expect(isSafeAfterMinerUPath("source/constructor/full.md")).toBe(false);
    expect(isSafeAfterMinerUPath("source/prototype/full.md")).toBe(false);
  });

  it("rejects magic object keys before unzip materialization", () => {
    const entries = Object.create(null) as Zippable;
    entries["__proto__/full.md"] = new TextEncoder().encode("# unsafe");
    const archive = zipSync(entries);
    expect(() => extractValidatedZipEntries(archive, {
      archiveBytes: 1024 * 1024,
      fileCount: 8,
      fileBytes: 1024,
      totalBytes: 4096,
      compressionRatio: 20,
      pathDepth: 4
    }, () => true)).toThrow(/object-backed|unsafe path/);
  });

  it("keeps embedded MinerU archive verification at the Repair input limits", () => {
    expect(AFTER_MINERU_SOURCE_ARCHIVE_LIMITS).toEqual({
      archiveBytes: 64 * 1024 * 1024,
      fileCount: 512,
      fileBytes: 64 * 1024 * 1024,
      totalBytes: 256 * 1024 * 1024,
      compressionRatio: 200,
      pathDepth: 16
    });
    const entries = Object.create(null) as Zippable;
    for (let index = 0; index < 513; index += 1) {
      entries[`files/${index}.txt`] = new Uint8Array([index & 0xff]);
    }
    const archive = zipSync(entries, { level: 0 });
    expect(() => extractValidatedZipEntries(
      archive,
      AFTER_MINERU_SOURCE_ARCHIVE_LIMITS,
      () => true
    )).toThrow(/entry count/);
  });
});
