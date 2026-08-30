import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  AFTER_MINERU_MANIFEST_PATH,
  type AfterMinerUManifest,
  type AfterMinerUReaderProjection,
  sha256Bytes
} from "../packages/after-mineru-contract/src/index";
import { repairMinerUArchive } from "../packages/repair-core/src/index";
import type { ReaderFileInfo, ReaderFileSystem } from "../src/filesystem/reader-file-system";
import { PackageLoader } from "../src/model/package-loader";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function rawArchive(withVisual: boolean): Uint8Array {
  const article = withVisual
    ? "# Paper\n\n![](images/figure.png)\n\nFigure 1. Bound visual.\n"
    : "# Paper\n";
  const content = withVisual ? [{
    type: "image",
    img_path: "images/figure.png",
    image_caption: ["Figure 1. Bound visual."],
    page_idx: 0,
    bbox: [10, 10, 900, 900]
  }] : [];
  return zipSync({
    "result/full.md": strToU8(article),
    "result/full_content_list.json": strToU8(JSON.stringify(content)),
    ...(withVisual ? { "result/images/figure.png": new Uint8Array([137, 80, 78, 71]) } : {})
  });
}

class MutablePackageFileSystem implements ReaderFileSystem {
  readonly rootLabel = "mutable-package";
  readonly dispose = vi.fn();
  private readonly reads = new Map<string, number>();

  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly onRead?: (path: string, count: number, bytes: Uint8Array) => Uint8Array
  ) {}

  set(path: string, bytes: Uint8Array): void { this.files.set(path, bytes.slice()); }
  resolvePath(path: string): string { return `mutable-package/${path}`; }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async fileInfo(path: string): Promise<ReaderFileInfo | undefined> {
    const bytes = this.files.get(path);
    return bytes ? { size: bytes.byteLength } : undefined;
  }
  async readText(path: string): Promise<string> { return decoder.decode(await this.bytes(path)); }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = await this.bytes(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async listFiles(directory: string): Promise<string[]> {
    const prefix = directory ? `${directory}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  }
  async resolveAssetUrl(path: string): Promise<string> { return `unverified://${path}`; }

  private async bytes(path: string): Promise<Uint8Array> {
    const stored = this.files.get(path);
    if (!stored) throw new Error(`Missing ${path}`);
    const count = (this.reads.get(path) ?? 0) + 1;
    this.reads.set(path, count);
    return (this.onRead?.(path, count, stored.slice()) ?? stored.slice()).slice();
  }
}

function mutableFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
}

function replaceDerivedArticle(files: Map<string, Uint8Array>, articleText: string): AfterMinerUManifest {
  const manifest = JSON.parse(decoder.decode(files.get(AFTER_MINERU_MANIFEST_PATH)!)) as AfterMinerUManifest;
  const articleBytes = encoder.encode(articleText);
  const articleRecord = manifest.derived.files.find((entry) => entry.path === manifest.derived.article_path)!;
  articleRecord.size = articleBytes.byteLength;
  articleRecord.sha256 = sha256Bytes(articleBytes);
  files.set(articleRecord.path, articleBytes);

  const provenancePath = manifest.sidecars.provenance_path;
  const provenance = JSON.parse(decoder.decode(files.get(provenancePath)!)) as {
    derived_article: typeof articleRecord;
  };
  provenance.derived_article = { ...articleRecord };
  const provenanceBytes = jsonBytes(provenance);
  const provenanceRecord = manifest.sidecars.files.find((entry) => entry.path === provenancePath)!;
  provenanceRecord.size = provenanceBytes.byteLength;
  provenanceRecord.sha256 = sha256Bytes(provenanceBytes);
  files.set(provenancePath, provenanceBytes);

  const projectionPath = manifest.sidecars.reader_projection_path;
  const projection = JSON.parse(decoder.decode(files.get(projectionPath)!)) as AfterMinerUReaderProjection;
  projection.inputs.derived_article = { ...articleRecord };
  const projectionBytes = jsonBytes(projection);
  const projectionRecord = manifest.sidecars.files.find((entry) => entry.path === projectionPath)!;
  projectionRecord.size = projectionBytes.byteLength;
  projectionRecord.sha256 = sha256Bytes(projectionBytes);
  files.set(projectionPath, projectionBytes);
  files.set(AFTER_MINERU_MANIFEST_PATH, jsonBytes(manifest));
  return manifest;
}

describe("After-MinerU Reader manifest binding", () => {
  it("parses the same Reader projection bytes that passed manifest verification", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(true) });
    const projectionPath = repaired.manifest.sidecars.reader_projection_path;
    let projectionReads = 0;
    const fileSystem = new MutablePackageFileSystem(mutableFiles(repaired.files), (path, count, bytes) => {
      if (path !== projectionPath) return bytes;
      projectionReads = count;
      if (count < 2) return bytes;
      const invalidSameSizeJson = new Uint8Array(bytes.byteLength).fill(0x20);
      invalidSameSizeJson[0] = 0x7b;
      return invalidSameSizeJson;
    });

    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.packageIntegrity).toBe("verified");
    expect(projectionReads).toBe(1);
    loaded.contentFileSystem?.dispose();
  });

  it("revalidates the derived article at the validation-to-render boundary", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(false) });
    const articlePath = repaired.manifest.derived.article_path;
    const fileSystem = new MutablePackageFileSystem(mutableFiles(repaired.files), (path, count, bytes) => {
      if (path === articlePath && count >= 2) bytes[0] = bytes[0]! ^ 1;
      return bytes;
    });

    await expect(new PackageLoader(fileSystem).loadDetected())
      .rejects.toThrow(/Manifest-bound file bytes changed/);
  });

  it("rejects a formally hashed derived Markdown resource that is not a manifest record or alias", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(false) });
    const files = mutableFiles(repaired.files);
    replaceDerivedArticle(files, "# Paper\n\n![](unlisted.png)\n");
    files.set("unlisted.png", new Uint8Array([1, 2, 3]));
    const fileSystem = new MutablePackageFileSystem(files);

    await expect(new PackageLoader(fileSystem).loadDetected())
      .rejects.toThrow(/derived Markdown references an unbound resource: unlisted\.png/);
  });

  it("rejects a manifest-bound projection whose placement is absent from the derived Markdown", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(true) });
    const files = mutableFiles(repaired.files);
    const manifest = JSON.parse(decoder.decode(files.get(AFTER_MINERU_MANIFEST_PATH)!)) as AfterMinerUManifest;
    const projectionPath = manifest.sidecars.reader_projection_path;
    const projection = JSON.parse(decoder.decode(files.get(projectionPath)!)) as AfterMinerUReaderProjection;
    projection.visuals[0]!.placement_block_id = "slot_missing_from_article";
    const projectionBytes = jsonBytes(projection);
    files.set(projectionPath, projectionBytes);
    const projectionRecord = manifest.sidecars.files.find((entry) => entry.path === projectionPath)!;
    projectionRecord.size = projectionBytes.byteLength;
    projectionRecord.sha256 = sha256Bytes(projectionBytes);
    files.set(AFTER_MINERU_MANIFEST_PATH, jsonBytes(manifest));

    await expect(new PackageLoader(new MutablePackageFileSystem(files)).loadDetected())
      .rejects.toThrow(/visual placement is not bound/);
  });

  it("rejects a placement slot whose Markdown marker names a different visual", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(true) });
    const files = mutableFiles(repaired.files);
    const manifest = JSON.parse(decoder.decode(files.get(AFTER_MINERU_MANIFEST_PATH)!)) as AfterMinerUManifest;
    const projectionPath = manifest.sidecars.reader_projection_path;
    const projection = JSON.parse(decoder.decode(files.get(projectionPath)!)) as AfterMinerUReaderProjection;
    const placement = `slot_${"1".repeat(24)}`;
    projection.visuals[0]!.placement_block_id = placement;
    files.set(projectionPath, jsonBytes(projection));
    replaceDerivedArticle(
      files,
      `# Paper\n\n<!-- p2md:slot id="${placement}" asset="ast_${"f".repeat(24)}" -->\n`
    );

    await expect(new PackageLoader(new MutablePackageFileSystem(files)).loadDetected())
      .rejects.toThrow(/visual placement is not bound/);
  });

  it("carries a post-validation content file system that rejects later asset replacement", async () => {
    const repaired = await repairMinerUArchive({ archiveBytes: rawArchive(true) });
    const files = mutableFiles(repaired.files);
    const fileSystem = new MutablePackageFileSystem(files);
    const loaded = await new PackageLoader(fileSystem).loadDetected();
    const assetPath = loaded.assets[0]!.path;
    const tampered = files.get(assetPath)!.slice();
    tampered[0] = tampered[0]! ^ 1;
    fileSystem.set(assetPath, tampered);

    expect(loaded.contentFileSystem).toBeDefined();
    await expect(loaded.contentFileSystem!.resolveAssetUrl(assetPath))
      .rejects.toThrow(/Manifest-bound file bytes changed/);
    loaded.contentFileSystem!.dispose();
    expect(fileSystem.dispose).not.toHaveBeenCalled();
  });
});
