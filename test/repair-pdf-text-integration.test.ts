import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256Bytes,
  sha256Utf8,
  type AfterMinerUDisplayRepairContract
} from "../packages/after-mineru-contract/src/index";
import {
  buildMineruViewerIndex,
  extractMarkdownImageOccurrences,
  generateMinerUReplacementCharacterDisplayRepair,
  repairMinerUArchive
} from "../packages/repair-core/src/index";
import { resolveRepairPdfText } from "../sites-reader/app/repair/pdf-text-resolver";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import { collectMinerUTextRecoveryCandidates } from "../src/model/mineru-text-recovery";

const demoRoot = resolve("sites-reader", "public", "demo", "debyecalculator");
const decoder = new TextDecoder("utf-8", { fatal: true });

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function displayRepair(output: Awaited<ReturnType<typeof repairMinerUArchive>>): AfterMinerUDisplayRepairContract {
  const path = output.manifest.sidecars.display_repair_path;
  expect(path).not.toBeNull();
  return JSON.parse(decode(output.files.get(path!)!)) as AfterMinerUDisplayRepairContract;
}

describe("browser PDF text repair integration", () => {
  it("deterministically repairs real Debye body text and preserves every selected source byte", async () => {
    const [archiveBuffer, explicitPdfBuffer] = await Promise.all([
      readFile(resolve(demoRoot, "mineru-original.mineru.zip")),
      readFile(resolve(demoRoot, "source.pdf"))
    ]);
    const archiveBytes = new Uint8Array(archiveBuffer);
    const explicitPdfBytes = new Uint8Array(explicitPdfBuffer);
    const extraction = extractMinerUArchiveForReader(archiveBytes);
    const articleBytes = extraction.files.get(extraction.articlePath)!;
    const contentListBytes = extraction.files.get(extraction.contentListPath)!;
    const sourceArticle = decode(articleBytes);
    const mineruPayload = JSON.parse(decode(contentListBytes)) as unknown;
    const articleHash = sha256Bytes(articleBytes);
    const mineruHash = sha256Bytes(contentListBytes);
    const candidates = collectMinerUTextRecoveryCandidates(mineruPayload, sourceArticle);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "mineru-text-000019",
      "mineru-text-000047"
    ]);

    const evidence = await resolveRepairPdfText(candidates, {
      pdfBytes: explicitPdfBytes,
      pdfSha256: sha256Bytes(explicitPdfBytes)
    });
    expect(evidence).toHaveLength(2);
    const viewerIndex = buildMineruViewerIndex(
      mineruPayload,
      extractMarkdownImageOccurrences(sourceArticle),
      { article: articleHash, mineru_result: mineruHash },
      { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
    );
    const generated = generateMinerUReplacementCharacterDisplayRepair({
      viewerIndex,
      mineruPayload,
      sourceArticle,
      articleHash,
      mineruHash,
      sourcePdfHash: sha256Bytes(explicitPdfBytes),
      evidence
    });
    expect(generated).toMatchObject({
      candidateCount: 2,
      repairCount: 2,
      recoveredReplacementCharacterCount: 11,
      abstainedCandidateIds: []
    });
    expect(generated.contract!.repairs.map((repair) => ({
      id: repair.id,
      replacementHash: sha256Utf8(repair.replacement_markdown)
    }))).toEqual([
      {
        id: "auto-mineru-text-000019",
        replacementHash: "f866879900820ac02ef23250934ff5755dc100e59e1c604cd21eddb539d2dd0f"
      },
      {
        id: "auto-mineru-text-000047",
        replacementHash: "f4679ea0d7a5d5a840659673ccac07e304853ede47036ad58bd191f4dae2097f"
      }
    ]);

    const explicit = await repairMinerUArchive({
      archiveBytes,
      archiveName: "debyecalculator.mineru.zip",
      sourcePdf: { bytes: explicitPdfBytes, name: "source.pdf" }
    }, { resolvePdfText: resolveRepairPdfText });
    expect(sha256Bytes(explicit.files.get(explicit.manifest.source.article_path)!)).toBe(articleHash);
    expect(sha256Bytes(explicit.files.get(explicit.manifest.source.pdf_path!)!)).toBe(sha256Bytes(explicitPdfBytes));
    expect(explicit.validation.summary.unresolved_text_replacement_count).toBe(22);
    expect(displayRepair(explicit).repairs).toHaveLength(2);

    const embeddedPdfPath = [...extraction.files.keys()].find((path) => /_origin\.pdf$/iu.test(path));
    expect(embeddedPdfPath).toBeDefined();
    const embeddedPdfBytes = extraction.files.get(embeddedPdfPath!)!;
    expect(sha256Bytes(embeddedPdfBytes)).not.toBe(sha256Bytes(explicitPdfBytes));
    const embedded = await repairMinerUArchive({
      archiveBytes,
      archiveName: "debyecalculator.mineru.zip"
    }, { resolvePdfText: resolveRepairPdfText });
    expect(sha256Bytes(embedded.files.get(embedded.manifest.source.article_path)!)).toBe(articleHash);
    expect(sha256Bytes(embedded.files.get(embedded.manifest.source.pdf_path!)!)).toBe(sha256Bytes(embeddedPdfBytes));
    expect(displayRepair(embedded).inputs.source_pdf.sha256).toBe(sha256Bytes(embeddedPdfBytes));
    expect(decode(embedded.files.get(embedded.manifest.derived.article_path)!))
      .toBe(decode(explicit.files.get(explicit.manifest.derived.article_path)!));
  }, 30_000);

  it("abstains for an unreadable text layer but rejects mismatched PDF bindings", async () => {
    const bytes = new TextEncoder().encode("%PDF-unreadable");
    const request = [{
      id: "mineru-text-000001",
      pageIndex: 0,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      sourceText: "damaged � text"
    }];
    await expect(resolveRepairPdfText(request, {
      pdfBytes: bytes,
      pdfSha256: sha256Bytes(bytes)
    })).resolves.toEqual([]);
    await expect(resolveRepairPdfText(request, {
      pdfBytes: bytes,
      pdfSha256: "0".repeat(64)
    })).rejects.toThrow("not bound");
  });
});
