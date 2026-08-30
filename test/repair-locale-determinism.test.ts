import { describe, expect, it } from "vitest";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  buildMineruVisualRepair,
  extractMarkdownImageOccurrences
} from "../packages/repair-core/src/reader-contract-generator";
import { parseMinerUContentList } from "../src/model/mineru-content-list";
import { applyMinerUVisualRepair } from "../src/model/mineru-visual-repair";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a record");
  return value as UnknownRecord;
}

function underSimulatedTurkishDefaultLocale<T>(operation: () => T): { result: T; defaultLocaleCalls: number } {
  const originalLower = String.prototype.toLocaleLowerCase;
  const originalUpper = String.prototype.toLocaleUpperCase;
  let defaultLocaleCalls = 0;

  String.prototype.toLocaleLowerCase = function (locales?: Intl.LocalesArgument): string {
    if (locales !== undefined) return Reflect.apply(originalLower, this, [locales]) as string;
    defaultLocaleCalls += 1;
    return String(this).replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase();
  };
  String.prototype.toLocaleUpperCase = function (locales?: Intl.LocalesArgument): string {
    if (locales !== undefined) return Reflect.apply(originalUpper, this, [locales]) as string;
    defaultLocaleCalls += 1;
    return String(this).replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase();
  };

  try {
    return { result: operation(), defaultLocaleCalls };
  } finally {
    String.prototype.toLocaleLowerCase = originalLower;
    String.prototype.toLocaleUpperCase = originalUpper;
  }
}

describe("After-MinerU locale-independent repair semantics", () => {
  it("classifies IMAGE and binds a FIGURE I caption without consulting the default locale", () => {
    const articleHash = "A".repeat(64);
    const mineruHash = "B".repeat(64);
    const caption = "FIGURE I. Informative uppercase-I caption for the complete visual.";
    const article = `# Paper\n\n![](images/IMAGE-I-a.png)\n\n![](images/IMAGE-I-b.png)\n\n${caption}\n`;
    const mineruPayload = [
      { type: "IMAGE", page_idx: 0, bbox: [100, 100, 420, 500], img_path: "images/IMAGE-I-a.png" },
      { type: "IMAGE", page_idx: 0, bbox: [460, 100, 800, 500], img_path: "images/IMAGE-I-b.png" },
      { type: "TEXT", page_idx: 0, bbox: [100, 540, 800, 620], text: caption }
    ];

    const simulated = underSimulatedTurkishDefaultLocale(() => {
      const viewer = buildMineruViewerIndex(
        mineruPayload,
        extractMarkdownImageOccurrences(article),
        { article: articleHash, mineru_result: mineruHash },
        { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
      );
      const generatedRepair = buildMineruVisualRepair(viewer);
      const candidates = buildMineruVisualCandidates(viewer, generatedRepair);
      const pages = record(viewer).pages as unknown[];
      const blocks = record(pages[0]).blocks as UnknownRecord[];
      const visualBlocks = blocks.slice(0, 2);
      const visualRepair = {
        schema_version: 1,
        inputs: record(viewer).inputs,
        groups: [{
          id: "uppercase-i-group",
          page_idx: 0,
          member_block_ids: visualBlocks.map((block) => block.id),
          member_asset_paths: visualBlocks.map((block) => block.asset_path),
          member_markdown_image_ids: visualBlocks.flatMap((block) => block.markdown_image_ids as string[]),
          decision: "auto",
          confidence: 0.95,
          replacement: { mode: "pdf_crop", bbox_norm: [100, 100, 800, 500], padding_norm: 6 }
        }],
        caption_links: []
      };
      const applied = applyMinerUVisualRepair({
        visuals: parseMinerUContentList(mineruPayload).visuals,
        viewerIndex: viewer,
        visualRepair,
        mineruPayload,
        articleMarkdown: article,
        articleHash,
        mineruHash,
        sourcePdfPath: "_extraction/source.pdf"
      });
      return { viewer, candidates, applied };
    });

    const page = record((record(simulated.result.viewer).pages as unknown[])[0]);
    const blocks = page.blocks as UnknownRecord[];
    expect(blocks.slice(0, 2).map((block) => block.role)).toEqual(["visual", "visual"]);
    expect(record(blocks[2].text).formal_figure_caption_keys).toEqual(["figure:i"]);
    expect(record(simulated.result.candidates).inputs).toMatchObject({
      article: { sha256: "a".repeat(64) },
      mineru_result: { sha256: "b".repeat(64) }
    });
    expect(simulated.result.applied.visuals).toHaveLength(1);
    expect(simulated.result.applied.visuals[0]).toMatchObject({
      label: "FIGURE I",
      captionText: caption,
      display: { mode: "pdf-crop", pdfPath: "_extraction/source.pdf" }
    });
    expect(simulated.result.applied.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "mineru-viewer-source-binding-invalid" })
    );
    expect(simulated.defaultLocaleCalls).toBe(0);
  });
});
