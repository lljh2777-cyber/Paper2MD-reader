import { describe, expect, it } from "vitest";
import {
  applyRecoveredText,
  collectMinerUTextRecoveryCandidates,
  recoverReplacementCharacters
} from "../src/model/mineru-text-recovery";

const source = "In these equations, parameters of the model (biases or matrices) and � represents the set of neighbors of a cell in the subgraph �. After L sequential layers, each node has a feature vector. Then, to obtain a unified representation for the entire subgraph �, we employ an attention aggregation layer.";
const pdfText = "In these equations, parameters of the model (biases or matrices) and 𝒩𝒩 represents the set of neighbors of a cell in the subgraph 𝒢𝒢. After L sequential layers, each node has a feature vector. Then, to obtain a unified representation for the entire subgraph 𝒢𝒢, we employ an attention aggregation layer.";

describe("MinerU PDF text recovery", () => {
  it("recovers uniquely bounded duplicated mathematical glyphs", () => {
    const recovered = recoverReplacementCharacters(source, pdfText);
    expect(recovered).toEqual({
      text: source.replace("�", "𝒩").replace("�", "𝒢").replace("�", "𝒢"),
      recoveredCount: 3
    });
  });

  it("abstains when the PDF context is ambiguous or incomplete", () => {
    expect(recoverReplacementCharacters(source, `${pdfText} ${pdfText}`)).toBeUndefined();
    expect(recoverReplacementCharacters(source, "unrelated PDF text")).toBeUndefined();
  });

  it("uses a unique punctuation-bound right context when malformed LaTeX removed the left anchor", () => {
    const malformed = "during training, and ${ \\bf h } = embed({ \\bf x }, i $ �) during inference. For each layer l, the node features are calculated.";
    const pdf = "during training, and h = embed(x, 𝒫𝒫) during inference. For each layer l, the node features are calculated.";
    expect(recoverReplacementCharacters(malformed, pdf)?.text).toContain("𝒫) during inference");
  });

  it("collects only uniquely located text blocks with valid page geometry", () => {
    const raw = [{ type: "text", page_idx: 12, bbox: [507, 641, 946, 836], text: source }];
    expect(collectMinerUTextRecoveryCandidates(raw, `# Paper\n\n${source}\n`)).toEqual([{
      id: "mineru-text-000000",
      pageIndex: 12,
      bbox: { x: 0.507, y: 0.641, width: 0.439, height: 0.195 },
      sourceText: source
    }]);
    expect(collectMinerUTextRecoveryCandidates(raw, `${source}\n${source}`)).toEqual([]);
  });

  it("applies recovered text only when the source block is unique", () => {
    const recovered = source.replace("�", "𝒩").replace("�", "𝒢").replace("�", "𝒢");
    expect(applyRecoveredText(`# Paper\n\n${source}`, source, recovered)).toContain("𝒩");
    expect(applyRecoveredText(`${source}\n${source}`, source, recovered)).toBeUndefined();
  });
});
