import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareMinerUDisplayRepair } from "../src/model/mineru-display-repair";

type RepairTarget = "article" | "caption";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(input: {
  target: RepairTarget;
  sourceText: string;
  replacementMarkdown: string;
  mineruPayload: unknown[];
  sourceIndex: number;
  sourcePdfHash?: string;
}) {
  const articleHash = sha256(input.sourceText);
  const mineruHash = sha256(JSON.stringify(input.mineruPayload));
  const sourcePdfHash = input.sourcePdfHash ?? sha256("source-pdf");
  const block = {
    id: "p0000-s000001",
    source_index: input.sourceIndex,
    role: input.target === "caption" ? "visual" : "text",
    caption: input.target === "caption"
      ? { items: [{ text: input.sourceText, kind: "formal-caption" }] }
      : { items: [] }
  };
  return {
    contract: {
      schema_version: 1,
      algorithm_version: "source-pdf-exact-display-repair-v1",
      inputs: {
        article: { sha256: articleHash },
        mineru_result: { sha256: mineruHash },
        source_pdf: { sha256: sourcePdfHash }
      },
      repairs: [{
        id: "repair-1",
        target: input.target,
        source_block_id: block.id,
        page_index: 0,
        source_text: input.sourceText,
        replacement_markdown: input.replacementMarkdown,
        source_text_sha256: sha256(input.sourceText),
        replacement_markdown_sha256: sha256(input.replacementMarkdown)
      }],
      summary: {}
    },
    viewerIndex: { schema_version: 1, pages: [{ page_idx: 0, blocks: [block] }] },
    mineruPayload: input.mineruPayload,
    sourceArticle: input.sourceText,
    articleHash,
    mineruHash,
    sourcePdfHash
  };
}

describe("MinerU display repair binding", () => {
  it("rejects display repair when the source PDF hash is missing", async () => {
    const sourceText = "Broken � text";
    const input = fixture({
      target: "article",
      sourceText,
      replacementMarkdown: "Repaired text",
      mineruPayload: [{ text: sourceText }],
      sourceIndex: 0,
      sourcePdfHash: ""
    });

    await expect(prepareMinerUDisplayRepair(input)).rejects.toThrow(/源 PDF|不匹配/);
  });

  it("preserves non-object MinerU entries when resolving viewer source_index", async () => {
    const sourceText = "Broken � text";
    const input = fixture({
      target: "article",
      sourceText,
      replacementMarkdown: "Repaired text",
      mineruPayload: [null, { text: sourceText }],
      sourceIndex: 1
    });

    const plan = await prepareMinerUDisplayRepair(input);
    expect(plan.article).toHaveLength(1);
    expect(plan.article[0]).toMatchObject({ sourceBlockId: "p0000-s000001", sourceText });
  });

  it("rejects a caption repair when the raw MinerU caption does not match", async () => {
    const sourceText = "Figure 1: Broken � caption.";
    const input = fixture({
      target: "caption",
      sourceText,
      replacementMarkdown: "Figure 1: Repaired caption.",
      mineruPayload: [{ type: "image", image_caption: ["Figure 1: Different caption."] }],
      sourceIndex: 0
    });

    await expect(prepareMinerUDisplayRepair(input)).rejects.toThrow("图注修复记录未绑定唯一原始图注");
  });
});
