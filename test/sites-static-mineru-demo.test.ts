import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserDirectoryReaderFileSystem } from "../src/filesystem/browser-directory-reader-file-system";
import { extractClippingArchiveBytes } from "../src/model/clipping-archive";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import { PackageLoader } from "../src/model/package-loader";
import { DEBYE_CALCULATOR_DEMO, type StaticDemoAsset } from "../sites-reader/lib/static-mineru-demo";

const demoRoot = resolve(import.meta.dirname, "..", "sites-reader", "public", "demo", "debyecalculator");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filename(asset: StaticDemoAsset): string {
  return asset.path.split("/").pop()!;
}

async function assetBytes(asset: StaticDemoAsset): Promise<Uint8Array> {
  return readFile(resolve(demoRoot, filename(asset)));
}

function asFile(path: string, bytes: Uint8Array): File {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([data], path.split("/").pop() ?? path);
}

describe("Sites real MinerU demo", () => {
  it("pins every public source and derived asset to an exact size and SHA-256", async () => {
    const assets: StaticDemoAsset[] = [
      DEBYE_CALCULATOR_DEMO.sourcePdf,
      DEBYE_CALCULATOR_DEMO.sourcePreview,
      DEBYE_CALCULATOR_DEMO.rawArchive,
      DEBYE_CALCULATOR_DEMO.derivedPackage,
      ...Object.values(DEBYE_CALCULATOR_DEMO.sidecars)
    ];
    for (const asset of assets) {
      const bytes = await assetBytes(asset);
      expect(bytes.byteLength, asset.path).toBe(asset.size);
      expect(sha256(bytes), asset.path).toBe(asset.sha256);
    }
    const attribution = await readFile(resolve(demoRoot, "ATTRIBUTION.md"), "utf8");
    expect(attribution).toContain("CC BY 4.0");
    expect(attribution).toContain("10.21105/joss.06024");
    expect(attribution).toContain("并非同一字节序列");
  });

  it("keeps MinerU text immutable while exposing only source-verified display repairs in the Reader projection", async () => {
    const [rawArchive, viewerText, displayRepairText, validationText, stylesheet] = await Promise.all([
      assetBytes(DEBYE_CALCULATOR_DEMO.rawArchive),
      readFile(resolve(demoRoot, "viewer-index.json"), "utf8"),
      readFile(resolve(demoRoot, "display-repair.json"), "utf8"),
      readFile(resolve(demoRoot, "validation.json"), "utf8"),
      readFile(resolve(import.meta.dirname, "..", "sites-reader", "app", "globals.css"), "utf8")
    ]);
    const extracted = extractMinerUArchiveForReader(rawArchive);
    const rawMarkdown = new TextDecoder().decode(extracted.files.get(extracted.articlePath)!);
    const displayRepair = JSON.parse(displayRepairText) as {
      algorithm_version?: string;
      inputs?: { source_pdf?: { sha256?: string } };
      repairs?: Array<{ target?: string; replacement_markdown?: string }>;
      summary?: Record<string, unknown>;
    };
    const validation = JSON.parse(validationText) as { display_repair?: Record<string, unknown> };
    const viewer = JSON.parse(viewerText) as { markdown_images?: Array<{ id?: string; asset_path?: string; char_start?: number; char_end?: number }> };
    const visualRepair = JSON.parse(await readFile(resolve(demoRoot, "visual-repair.json"), "utf8")) as {
      groups?: Array<{ decision?: string; member_markdown_image_ids?: string[] }>;
    };

    expect([...rawMarkdown].filter((character) => character === "�")).toHaveLength(33);
    expect([...viewerText].filter((character) => character === "�")).toHaveLength(22);
    expect(displayRepair).toMatchObject({
      algorithm_version: "source-pdf-exact-display-repair-v1",
      inputs: { source_pdf: { sha256: DEBYE_CALCULATOR_DEMO.sourcePdf.sha256 } },
      summary: {
        repair_count: 4,
        article_repair_count: 2,
        caption_repair_count: 2,
        replacement_characters_before: 33,
        replacement_characters_after: 0
      }
    });
    expect(displayRepair.repairs).toHaveLength(4);
    expect(displayRepair.repairs?.filter((repair) => repair.target === "caption").map((repair) => repair.replacement_markdown).join("\n"))
      .toContain("$G(r)$");
    expect(validation.display_repair).toMatchObject({
      repair_count: 4,
      replacement_characters_before: 33,
      replacement_characters_after: 0
    });
    expect(stylesheet).toMatch(/html body\s*\{[^}]*overflow:\s*auto;/s);
    expect(stylesheet).toMatch(/\.demo-reader-mount :is\([^}]+\)\s*\{\s*overscroll-behavior:\s*auto;/s);
    expect(stylesheet).toMatch(/\.demo-raw-preview\.p2md-article\s*\{[^}]*overflow:\s*auto;/s);
    const focusIds = visualRepair.groups?.filter((group) => group.decision === "auto")[0]?.member_markdown_image_ids ?? [];
    expect(focusIds).toHaveLength(4);
    const focusPaths = focusIds.map((id) => {
      const entry = viewer.markdown_images?.filter((image) => image.id === id);
      expect(entry).toHaveLength(1);
      const match = entry![0];
      expect(rawMarkdown.slice(match.char_start, match.char_end)).toContain(match.asset_path);
      return match.asset_path;
    });
    expect(new Set(focusPaths).size).toBe(4);
  });

  it("fails closed when the manifest-bound display repair sidecar is stale", async () => {
    const packageBytes = await assetBytes(DEBYE_CALCULATOR_DEMO.derivedPackage);
    const files = extractClippingArchiveBytes(packageBytes);
    const original = files.get("_extraction/display-repair.json")!;
    const bytes = new Uint8Array(await original.arrayBuffer());
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    files.set("_extraction/display-repair.json", asFile("_extraction/display-repair.json", bytes));
    const fileSystem = BrowserDirectoryReaderFileSystem.fromFileMap("DebyeCalculator stale repair", files);
    try {
      const loaded = await new PackageLoader(fileSystem).loadDetected();
      expect(loaded.packageIntegrity).toBe("verified");
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-display-repair-invalid" }));
      expect(loaded.articleText).toContain("�");
      expect(loaded.assets.map((asset) => asset.captionText ?? "").join("\n")).toContain("�");
    } finally {
      fileSystem.dispose();
    }
  });

  it("preserves the uploaded PDF and the different MinerU origin PDF as distinct immutable sources", async () => {
    const [sourcePdf, rawArchive, provenanceText] = await Promise.all([
      assetBytes(DEBYE_CALCULATOR_DEMO.sourcePdf),
      assetBytes(DEBYE_CALCULATOR_DEMO.rawArchive),
      readFile(resolve(demoRoot, "provenance.json"), "utf8")
    ]);
    const extracted = extractMinerUArchiveForReader(rawArchive);
    const origin = [...extracted.files].find(([path]) => /_origin\.pdf$/i.test(path));
    expect(origin).toBeDefined();
    expect(sha256(sourcePdf)).toBe(DEBYE_CALCULATOR_DEMO.sourcePdf.sha256);
    expect(sha256(origin![1])).toBe("965c7c589d2eaa5622e6d5b78ef34fa0aa015e35a6b025ad605cb7199a972602");
    expect(origin![1]).not.toEqual(sourcePdf);
    const provenance = JSON.parse(provenanceText) as { source_pdf_matches_mineru_origin_pdf?: unknown };
    expect(provenance.source_pdf_matches_mineru_origin_pdf).toBe(false);
    expect(extracted).toMatchObject({ fileCount: 13, markdownCount: 1, jsonCount: 4, imageCount: 7 });
  });

  it("loads the downloadable package only after manifest and deterministic repair verification", async () => {
    const [packageBytes, rawArchive, sourcePdf] = await Promise.all([
      assetBytes(DEBYE_CALCULATOR_DEMO.derivedPackage),
      assetBytes(DEBYE_CALCULATOR_DEMO.rawArchive),
      assetBytes(DEBYE_CALCULATOR_DEMO.sourcePdf)
    ]);
    const files = extractClippingArchiveBytes(packageBytes);
    const fileSystem = BrowserDirectoryReaderFileSystem.fromFileMap("DebyeCalculator verified demo", files);
    try {
      const loaded = await new PackageLoader(fileSystem).loadDetected();
      expect(loaded).toMatchObject({
        sourceFormat: "mineru",
        state: "mineru",
        packageIntegrity: "verified",
        contractVersion: "mineru-viewer-index-v1",
        sourcePdf: { path: "_extraction/source.pdf" }
      });
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-package-integrity-verified" }));
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-visual-repair-applied" }));
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "mineru-display-repair-verified" }));
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
        code: "mineru-reader-projection-applied",
        message: expect.stringContaining("3 段可验证图注")
      }));
      expect(loaded.assets).toContainEqual(expect.objectContaining({
        memberAssetPaths: expect.arrayContaining([
          "images/d1b774fd69b46553ec459ec80c9495cd6f43bc1bfe968d054cb4d9917db268cc.jpg",
          "images/ee3cee50e4c8f67f62c327bd37f1e1d36bdd3526660d2a9fc8be0635d514f805.jpg",
          "images/f6aae6ebac53f6ab69f1904b99f44fe7c723a069694d1168a66d3177de3fe101.jpg",
          "images/fc338a26fd8ee343a26cf83a1787661e3b08bf702933a6d3ba6888a928a4ed02.jpg"
        ])
      }));
      expect(loaded.assets.map((asset) => asset.captionText ?? "").join("\n")).not.toContain("�");
      expect(loaded.articleText).not.toContain("�");
      expect(loaded.articleText).not.toContain("Figure 1: Computation-time comparison");
      expect(loaded.articleText).not.toContain("Figure 2: The interact mode of DebyeCalculator");
      expect(loaded.articleText).not.toContain("Figure 3: Comparison of the calculated");
      expect(loaded.articleText).toContain("where users can calculate $I(Q)$, $S(Q)$, $F(Q)$, and $G(r)$");
      expect(loaded.assets).toContainEqual(expect.objectContaining({
        display_label: "Figure 2",
        captionText: expect.stringContaining("visualise $I(Q)$, $S(Q)$, $F(Q)$, and $G(r)$")
      }));
      const embeddedArchive = new Uint8Array(await files.get("_source/mineru-original.mineru.zip")!.arrayBuffer());
      const packagedSource = new Uint8Array(await files.get("_extraction/source.pdf")!.arrayBuffer());
      expect(embeddedArchive.byteLength).toBe(rawArchive.byteLength);
      expect(sha256(embeddedArchive)).toBe(sha256(rawArchive));
      expect(packagedSource.byteLength).toBe(sourcePdf.byteLength);
      expect(sha256(packagedSource)).toBe(sha256(sourcePdf));
      const rawExtraction = extractMinerUArchiveForReader(rawArchive);
      const rawMarkdown = rawExtraction.files.get(rawExtraction.articlePath)!;
      expect(await files.get("article.md")!.text()).toBe(new TextDecoder().decode(rawMarkdown));
      expect(await files.get(rawExtraction.articlePath)!.text()).toBe(new TextDecoder().decode(rawMarkdown));
      for (const [path, asset] of [
        ["_extraction/viewer-index.json", DEBYE_CALCULATOR_DEMO.sidecars.viewerIndex],
        ["_extraction/visual-repair.json", DEBYE_CALCULATOR_DEMO.sidecars.visualRepair],
        ["_extraction/visual-candidates.json", DEBYE_CALCULATOR_DEMO.sidecars.visualCandidates],
        ["_extraction/display-repair.json", DEBYE_CALCULATOR_DEMO.sidecars.displayRepair],
        ["_extraction/validation.json", DEBYE_CALCULATOR_DEMO.sidecars.validation],
        ["_source/provenance.json", DEBYE_CALCULATOR_DEMO.sidecars.provenance]
      ] as const) {
        const embedded = new Uint8Array(await files.get(path)!.arrayBuffer());
        expect(embedded.byteLength, path).toBe(asset.size);
        expect(sha256(embedded), path).toBe(asset.sha256);
      }
    } finally {
      fileSystem.dispose();
    }
  });

  it("can compose the browser demo from the exact raw File objects plus non-conflicting sidecars", async () => {
    const rawArchiveBytes = await assetBytes(DEBYE_CALCULATOR_DEMO.rawArchive);
    const extracted = extractMinerUArchiveForReader(rawArchiveBytes);
    const rawArchive = asFile("mineru-original.mineru.zip", rawArchiveBytes);
    const files = new Map<string, File>();
    for (const [path, bytes] of extracted.files) files.set(path, asFile(path, bytes));
    const sourceArticle = files.get(extracted.articlePath)!;
    const derivedEntries: Array<[string, StaticDemoAsset]> = [
      ["_source/ATTRIBUTION.md", DEBYE_CALCULATOR_DEMO.sidecars.attribution],
      ["_source/provenance.json", DEBYE_CALCULATOR_DEMO.sidecars.provenance],
      ["_extraction/source.pdf", DEBYE_CALCULATOR_DEMO.sourcePdf],
      ["_extraction/viewer-index.json", DEBYE_CALCULATOR_DEMO.sidecars.viewerIndex],
      ["_extraction/visual-repair.json", DEBYE_CALCULATOR_DEMO.sidecars.visualRepair],
      ["_extraction/visual-candidates.json", DEBYE_CALCULATOR_DEMO.sidecars.visualCandidates],
      ["_extraction/display-repair.json", DEBYE_CALCULATOR_DEMO.sidecars.displayRepair],
      ["_extraction/manifest.json", DEBYE_CALCULATOR_DEMO.sidecars.manifest],
      ["_extraction/validation.json", DEBYE_CALCULATOR_DEMO.sidecars.validation]
    ];
    files.set("_source/mineru-original.mineru.zip", rawArchive);
    for (const [path, asset] of derivedEntries) {
      expect(files.has(path)).toBe(false);
      files.set(path, asFile(path, await assetBytes(asset)));
    }
    const fileSystem = BrowserDirectoryReaderFileSystem.fromMinerUArchive(
      "DebyeCalculator runtime demo",
      files,
      {
        format: "mineru-zip",
        sourceArchive: rawArchive,
        sourceRootPrefix: extracted.rootPrefix,
        articlePath: extracted.articlePath,
        contentListPath: extracted.contentListPath,
        fileCount: extracted.fileCount,
        markdownCount: extracted.markdownCount,
        jsonCount: extracted.jsonCount,
        imageCount: extracted.imageCount
      }
    );
    try {
      const loaded = await new PackageLoader(fileSystem).loadDetected();
      expect(loaded.packageIntegrity).toBe("verified");
      expect(loaded.contractVersion).toBe("mineru-viewer-index-v1");
      expect(fileSystem.sourceArchive?.sourceArchive).toBe(rawArchive);
      expect(files.get(extracted.articlePath)).toBe(sourceArticle);
      expect(await fileSystem.readText(extracted.articlePath)).toBe(await sourceArticle.text());
    } finally {
      fileSystem.dispose();
    }
  });
});
