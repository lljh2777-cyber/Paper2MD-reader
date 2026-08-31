import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AFTER_MINERU_DISPLAY_REPAIR_VERSION,
  sha256Bytes,
  sha256Utf8
} from "../packages/after-mineru-contract/src/index";
import {
  buildMineruViewerIndex,
  extractMarkdownImageOccurrences,
  generateMinerUReplacementCharacterDisplayRepair,
  repairMinerUArchive
} from "../packages/repair-core/src/index";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import { collectMinerUTextRecoveryCandidates } from "../src/model/mineru-text-recovery";
import {
  applyMinerUDisplayMarkdownRepairs,
  prepareMinerUDisplayRepair
} from "../src/model/mineru-display-repair";

const demoRoot = resolve("sites-reader", "public", "demo", "debyecalculator");

function fixture() {
  const sourceText = "The calibration paragraph has a uniquely bounded symbol � before the final measurement confirms the instrument response.";
  const recoveredText = sourceText.replace("�", "𝒯");
  const sourceArticle = `# Result\n\n${sourceText}\n`;
  const mineruPayload = [{
    type: "text",
    page_idx: 0,
    bbox: [100, 120, 900, 240],
    text: sourceText
  }];
  const articleHash = sha256Utf8(sourceArticle);
  const mineruHash = sha256Utf8(JSON.stringify(mineruPayload));
  const sourcePdfHash = sha256Utf8("fixture-pdf");
  const viewerIndex = {
    schema_version: 1,
    pages: [{
      page_idx: 0,
      blocks: [{
        id: "p0000-s000000",
        source_index: 0,
        role: "text"
      }]
    }]
  };
  return {
    sourceText,
    recoveredText,
    sourceArticle,
    mineruPayload,
    articleHash,
    mineruHash,
    sourcePdfHash,
    viewerIndex,
    evidence: [{
      candidateId: "mineru-text-000000",
      pageIndex: 0,
      text: sourceText.replace("�", "𝒯𝒯")
    }]
  };
}

describe("Repair-core display repair generation", () => {
  it("generates a deterministic contract that the shared Reader validator accepts", async () => {
    const input = fixture();
    const first = generateMinerUReplacementCharacterDisplayRepair(input);
    const second = generateMinerUReplacementCharacterDisplayRepair(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      candidateCount: 1,
      repairCount: 1,
      recoveredReplacementCharacterCount: 1,
      abstainedCandidateIds: [],
      contract: {
        schema_version: 1,
        algorithm_version: AFTER_MINERU_DISPLAY_REPAIR_VERSION,
        repairs: [{
          id: "auto-mineru-text-000000",
          target: "article",
          source_block_id: "p0000-s000000",
          source_text: input.sourceText,
          replacement_markdown: input.recoveredText
        }]
      }
    });

    const plan = await prepareMinerUDisplayRepair({
      contract: first.contract,
      viewerIndex: input.viewerIndex,
      mineruPayload: input.mineruPayload,
      sourceArticle: input.sourceArticle,
      articleHash: input.articleHash,
      mineruHash: input.mineruHash,
      sourcePdfHash: input.sourcePdfHash
    });
    expect(applyMinerUDisplayMarkdownRepairs(input.sourceArticle, plan)).toContain(input.recoveredText);
    expect(input.sourceArticle).toContain(input.sourceText);
  });

  it("abstains on ambiguous or Markdown-active evidence and rejects unbound evidence", () => {
    const input = fixture();
    const duplicated = `${input.evidence[0].text} ${input.evidence[0].text}`;
    expect(generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: [{ ...input.evidence[0], text: duplicated }]
    })).toMatchObject({
      contract: null,
      repairCount: 0,
      abstainedCandidateIds: ["mineru-text-000000"]
    });
    expect(generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: [{ ...input.evidence[0], text: input.sourceText.replace("�", "**") }]
    })).toMatchObject({ contract: null, repairCount: 0 });
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: [{ ...input.evidence[0], candidateId: "mineru-text-999999" }]
    })).toThrow("not uniquely bound");
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: [{ ...input.evidence[0], pageIndex: 1 }]
    })).toThrow("not uniquely bound");
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: [input.evidence[0], input.evidence[0]]
    })).toThrow("not uniquely bound");
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      sourcePdfHash: ""
    })).toThrow("SHA-256");
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      evidence: Array.from({ length: 65 }, () => input.evidence[0])
    })).toThrow("bounded candidate limit");
    expect(() => generateMinerUReplacementCharacterDisplayRepair({
      ...input,
      viewerIndex: {
        schema_version: 1,
        pages: [input.viewerIndex.pages[0], input.viewerIndex.pages[0]]
      }
    })).toThrow("duplicate page");
  });

  it("materializes one generated repair while preserving the real demo MinerU source bytes", async () => {
    const [archiveBuffer, pdfBuffer] = await Promise.all([
      readFile(resolve(demoRoot, "mineru-original.mineru.zip")),
      readFile(resolve(demoRoot, "source.pdf"))
    ]);
    const archiveBytes = new Uint8Array(archiveBuffer);
    const pdfBytes = new Uint8Array(pdfBuffer);
    const extraction = extractMinerUArchiveForReader(archiveBytes);
    const articleBytes = extraction.files.get(extraction.articlePath)!;
    const contentListBytes = extraction.files.get(extraction.contentListPath)!;
    const sourceArticle = new TextDecoder("utf-8", { fatal: true }).decode(articleBytes);
    const mineruPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contentListBytes)) as unknown;
    const candidate = collectMinerUTextRecoveryCandidates(mineruPayload, sourceArticle)
      .find((value) => value.id === "mineru-text-000019")!;
    const sourceText = candidate.sourceText;
    const recoveredText = sourceText.replace("�", "N").replace("�", "ν").replace("�", "b");
    expect(candidate).toBeDefined();
    const articleHash = sha256Bytes(articleBytes);
    const mineruHash = sha256Bytes(contentListBytes);
    const viewerIndex = buildMineruViewerIndex(
      mineruPayload,
      extractMarkdownImageOccurrences(sourceArticle),
      { article: articleHash, mineru_result: mineruHash },
      { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
    );
    const evidence = [{
      candidateId: candidate.id,
      pageIndex: candidate.pageIndex,
      text: recoveredText
    }];
    const generated = generateMinerUReplacementCharacterDisplayRepair({
      viewerIndex,
      mineruPayload,
      sourceArticle,
      articleHash,
      mineruHash,
      sourcePdfHash: sha256Bytes(pdfBytes),
      evidence
    });
    expect(generated).toMatchObject({ repairCount: 1, recoveredReplacementCharacterCount: 3 });

    const output = await repairMinerUArchive({
      archiveBytes,
      archiveName: "debyecalculator.mineru.zip",
      sourcePdf: { bytes: pdfBytes, name: "source.pdf" }
    }, {
      resolvePdfText(requests, context) {
        expect(requests.find((request) => request.id === candidate.id)).toMatchObject(candidate);
        expect(context.pdfSha256).toBe(sha256Bytes(pdfBytes));
        context.pdfBytes.fill(0);
        return evidence;
      }
    });
    const sourceCopy = output.files.get(`source/${extraction.articlePath}`)!;
    const sourcePdfCopy = output.files.get("source/source.pdf")!;
    const derivedArticle = new TextDecoder().decode(output.files.get("derived/article.after-mineru.md")!);
    const displayRepair = JSON.parse(new TextDecoder().decode(output.files.get("sidecars/display-repair.json")!)) as {
      algorithm_version: string;
      repairs: unknown[];
    };
    expect(sha256Bytes(sourceCopy)).toBe(sha256Bytes(articleBytes));
    expect(sha256Bytes(sourcePdfCopy)).toBe(sha256Bytes(pdfBytes));
    expect(derivedArticle).toContain(recoveredText);
    expect(derivedArticle).not.toContain(sourceText);
    expect(displayRepair).toMatchObject({
      algorithm_version: AFTER_MINERU_DISPLAY_REPAIR_VERSION,
      repairs: [expect.objectContaining({ source_text: sourceText, replacement_markdown: recoveredText })]
    });

    await expect(repairMinerUArchive({
      archiveBytes,
      sourcePdf: { bytes: pdfBytes, name: "source.pdf" }
    }, {
      resolvePdfText() {
        return Array.from({ length: 65 }, () => evidence[0]);
      }
    })).rejects.toThrow("invalid evidence collection");
  });
});
