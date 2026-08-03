import { describe, expect, it } from "vitest";
import { ReaderFileInfo, ReaderFileSystem } from "../src/filesystem/reader-file-system";
import { normalizeContract } from "../src/model/contract-validation";
import { PACKAGE_LIMITS, PackageLimitError } from "../src/model/package-limits";
import { PackageLoader } from "../src/model/package-loader";
import { ReaderContract } from "../src/model/reader-contract";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";
import { makeArticle, makeContract } from "./reader-fixture";

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

class InstrumentedFileSystem implements ReaderFileSystem {
  readonly rootLabel = "instrumented";
  activeBinaryReads = 0;
  maxBinaryReads = 0;
  binaryReadCount = 0;
  textReadCount = 0;

  constructor(
    private readonly base: MemoryReaderFileSystem,
    private readonly infoOverrides = new Map<string, ReaderFileInfo>(),
    private readonly readDelayMs = 0
  ) {}

  resolvePath(path: string): string { return this.base.resolvePath(path); }
  exists(path: string): Promise<boolean> { return this.base.exists(path); }
  fileInfo(path: string): Promise<ReaderFileInfo | undefined> {
    return Promise.resolve(this.infoOverrides.get(path)).then((value) => value ?? this.base.fileInfo(path));
  }
  async readText(path: string): Promise<string> {
    this.textReadCount += 1;
    return this.base.readText(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    this.binaryReadCount += 1;
    this.activeBinaryReads += 1;
    this.maxBinaryReads = Math.max(this.maxBinaryReads, this.activeBinaryReads);
    try {
      if (this.readDelayMs) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
      return await this.base.readBinary(path);
    } finally {
      this.activeBinaryReads -= 1;
    }
  }
  listFiles(path: string): Promise<string[]> { return this.base.listFiles(path); }
  resolveAssetUrl(path: string): Promise<string> { return this.base.resolveAssetUrl(path); }
  dispose(): void { this.base.dispose(); }
}

function makeMultiAssetContract(count: number, image: Uint8Array): ReaderContract {
  const contract = makeContract();
  const templateSlot = contract.blocks.find((block) => block.kind === "visual_slot")!;
  const templateAsset = contract.assets[0];
  const articleBlocks = contract.blocks.filter((block) => block.kind !== "visual_slot" && block.kind !== "caption");
  contract.blocks = articleBlocks;
  contract.assets = [];
  contract.relations = [];

  for (let index = 0; index < count; index += 1) {
    const suffix = (index + 1).toString(16).padStart(24, "0");
    const assetId = `ast_${suffix}`;
    const slotId = `slot_${suffix}`;
    const relationId = `rel_${suffix}`;
    const path = `images/figure-${String(index + 1).padStart(4, "0")}.png`;
    contract.blocks.push({
      ...templateSlot,
      id: slotId,
      order: contract.blocks.length + 1,
      anchor: { syntax: "p2md:slot", id: slotId },
      asset_id: assetId
    });
    contract.assets.push({
      ...templateAsset,
      id: assetId,
      path,
      sha256: "0".repeat(64),
      size_bytes: image.byteLength,
      caption_block_id: null,
      placement_block_id: slotId
    });
    contract.relations.push({
      id: relationId,
      type: "places",
      source_id: slotId,
      target_id: assetId,
      label: null
    });
  }
  return contract;
}

describe("Paper2MD package resource boundaries", () => {
  it("rejects an oversized article before reading its text", async () => {
    const base = new MemoryReaderFileSystem({ "article.md": "# small fixture" });
    const fileSystem = new InstrumentedFileSystem(base, new Map([
      ["article.md", { size: PACKAGE_LIMITS.articleBytes + 1 }]
    ]));

    await expect(new PackageLoader(fileSystem).load()).rejects.toBeInstanceOf(PackageLimitError);
    expect(fileSystem.textReadCount).toBe(0);
  });

  it("rejects contracts above the asset-count boundary before graph traversal", () => {
    const contract = makeContract() as unknown as Record<string, unknown>;
    contract.assets = Array.from({ length: PACKAGE_LIMITS.assetCount + 1 }, () => makeContract().assets[0]);
    const result = normalizeContract(contract);

    expect(result.contract).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "too-many-assets" }));
  });

  it("does not read an asset whose actual size exceeds the safe limit", async () => {
    const article = makeArticle();
    const image = new Uint8Array([137, 80, 78, 71]);
    const contract = makeContract();
    contract.article.sha256 = await sha256(article);
    contract.assets[0].sha256 = await sha256(image);
    contract.assets[0].size_bytes = image.byteLength;
    const base = new MemoryReaderFileSystem({
      "article.md": article,
      "_paper2md/reader.json": JSON.stringify(contract),
      "images/figure-0001.png": image
    });
    const fileSystem = new InstrumentedFileSystem(base, new Map([
      ["images/figure-0001.png", { size: PACKAGE_LIMITS.assetBytes + 1 }]
    ]));

    await expect(new PackageLoader(fileSystem).load()).rejects.toBeInstanceOf(PackageLimitError);
    expect(fileSystem.binaryReadCount).toBe(0);
  });

  it("does not hash an asset after its declared and actual sizes disagree", async () => {
    const article = makeArticle();
    const image = new Uint8Array([137, 80, 78, 71]);
    const contract = makeContract();
    contract.article.sha256 = await sha256(article);
    contract.assets[0].size_bytes = image.byteLength + 1;
    const base = new MemoryReaderFileSystem({
      "article.md": article,
      "_paper2md/reader.json": JSON.stringify(contract),
      "images/figure-0001.png": image
    });
    const fileSystem = new InstrumentedFileSystem(base);

    const loaded = await new PackageLoader(fileSystem).load();

    expect(fileSystem.binaryReadCount).toBe(0);
    expect(loaded.assets[0].integrityMatches).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "asset-size-mismatch" }));
  });

  it("bounds concurrent full-file hashing while preserving valid package loading", async () => {
    const article = makeArticle();
    const image = new Uint8Array([137, 80, 78, 71]);
    const contract = makeMultiAssetContract(PACKAGE_LIMITS.assetHashConcurrency + 2, image);
    contract.article.sha256 = await sha256(article);
    const imageHash = await sha256(image);
    contract.assets.forEach((asset) => { asset.sha256 = imageHash; });
    const entries: Record<string, string | Uint8Array> = {
      "article.md": article,
      "_paper2md/reader.json": JSON.stringify(contract)
    };
    contract.assets.forEach((asset) => { entries[asset.path] = image; });
    const fileSystem = new InstrumentedFileSystem(new MemoryReaderFileSystem(entries), new Map(), 5);

    const loaded = await new PackageLoader(fileSystem).load();

    expect(loaded.assets).toHaveLength(contract.assets.length);
    expect(fileSystem.maxBinaryReads).toBeLessThanOrEqual(PACKAGE_LIMITS.assetHashConcurrency);
    expect(fileSystem.maxBinaryReads).toBeGreaterThan(1);
    expect(loaded.assets.every((asset) => asset.integrityMatches)).toBe(true);
  });
});
