import { describe, expect, it } from "vitest";
import {
  inspectMinerUPackageIntegrity,
  MinerUPackageIntegrityError,
  readVerifiedMinerUDerivedJson
} from "../src/model/mineru-package-integrity";
import { PackageLoader } from "../src/model/package-loader";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const result = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(result)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function size(value: string | Uint8Array): number {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

async function fixture(options: { staleArticle?: boolean; staleDerived?: boolean; validationStatus?: string } = {}) {
  const article = "# Verified paper\n\n![](images/a.png)\n";
  const mineru = JSON.stringify([{ type: "image", page_idx: 0, bbox: [20, 30, 900, 700], img_path: "images/a.png" }]);
  const image = new Uint8Array([137, 80, 78, 71]);
  const inputs = {
    article: { path: "article.md", sha256: await digest(article) },
    mineru_result: { path: "mineru-result.json", sha256: await digest(mineru) }
  };
  const viewerIndex = JSON.stringify({ schema_version: 1, inputs, pages: [] });
  const visualRepair = JSON.stringify({ schema_version: 1, inputs, groups: [] });
  const outputs = [
    { path: "article.md", size: size(article), sha256: await digest(options.staleArticle ? `${article}changed` : article) },
    { path: "mineru-result.json", size: size(mineru), sha256: await digest(mineru) },
    { path: "images/a.png", size: size(image), sha256: await digest(image) }
  ];
  const derived = [
    { path: "_extraction/viewer-index.json", size: size(viewerIndex), sha256: await digest(viewerIndex) },
    {
      path: "_extraction/visual-repair.json",
      size: size(visualRepair),
      sha256: options.staleDerived ? "0".repeat(64) : await digest(visualRepair)
    }
  ];
  const manifest = JSON.stringify({
    schema_version: 1,
    processing_depth: "conversion-only",
    source: { size: 100, sha256: "a".repeat(64) },
    options: { include_source_pdf: false },
    outputs,
    derived_contracts: derived
  });
  const files: Record<string, string | Uint8Array> = {
    "article.md": article,
    "mineru-result.json": mineru,
    "images/a.png": image,
    "_extraction/manifest.json": manifest,
    "_extraction/validation.json": JSON.stringify({ status: options.validationStatus ?? "passed" }),
    "_extraction/viewer-index.json": viewerIndex,
    "_extraction/visual-repair.json": visualRepair
  };
  return { article, mineru, files };
}

describe("MinerU formal package integrity", () => {
  it("verifies every manifest output and only exposes hash-bound derived contracts", async () => {
    const built = await fixture();
    const fileSystem = new MemoryReaderFileSystem(built.files);
    const integrity = await inspectMinerUPackageIntegrity({
      fileSystem,
      articlePath: "article.md",
      articleBytes: new TextEncoder().encode(built.article),
      mineruPath: "mineru-result.json",
      mineruBytes: new TextEncoder().encode(built.mineru),
      sourcePdfPath: "_extraction/source.pdf"
    });

    expect(integrity.status).toBe("verified");
    expect(integrity.derived.size).toBe(2);
    await expect(readVerifiedMinerUDerivedJson(
      fileSystem,
      "_extraction/viewer-index.json",
      integrity.derived.get("_extraction/viewer-index.json")
    )).resolves.toEqual(expect.objectContaining({ schema_version: 1 }));
  });

  it("refuses a formal package when validation failed or a core hash is stale", async () => {
    const failedValidation = await fixture({ validationStatus: "failed" });
    await expect(new PackageLoader(new MemoryReaderFileSystem(failedValidation.files)).loadDetected())
      .rejects.toThrow(MinerUPackageIntegrityError);

    const stale = await fixture({ staleArticle: true });
    await expect(new PackageLoader(new MemoryReaderFileSystem(stale.files)).loadDetected())
      .rejects.toThrow("文件哈希与 manifest.json 不一致：article.md");
  });

  it("rejects manifest traversal before reading anything outside the selected folder", async () => {
    const built = await fixture();
    const manifestPath = "_extraction/manifest.json";
    const manifest = JSON.parse(String(built.files[manifestPath])) as { outputs: unknown[] };
    manifest.outputs.push({ path: "../outside.txt", size: 1, sha256: "0".repeat(64) });
    built.files[manifestPath] = JSON.stringify(manifest);

    await expect(new PackageLoader(new MemoryReaderFileSystem(built.files)).loadDetected())
      .rejects.toThrow("manifest.json 含无效或重复的 outputs 记录");
  });

  it("opens verified core content but disables a stale derived visual repair", async () => {
    const built = await fixture({ staleDerived: true });
    const loaded = await new PackageLoader(new MemoryReaderFileSystem(built.files)).loadDetected();

    expect(loaded.packageIntegrity).toBe("verified");
    expect(loaded.assets).toHaveLength(1);
    expect(loaded.assets[0].display).toBeUndefined();
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-package-integrity-verified" }));
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-visual-repair-invalid" }));
  });

  it("marks a plain MinerU export as unverified without pretending it is a formal package", async () => {
    const loaded = await new PackageLoader(new MemoryReaderFileSystem({
      "article.md": "# Plain export\n",
      "mineru-result.json": "[]"
    })).loadDetected();

    expect(loaded.packageIntegrity).toBe("unverified");
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-package-unverified", level: "warning" }));
  });
});
