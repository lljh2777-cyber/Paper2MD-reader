import { describe, expect, it } from "vitest";
import { alignMinerUReplacementCharactersToPdfText } from "../packages/repair-core/src/index";

describe("bounded MinerU/PDF text alignment", () => {
  it("recovers only replacement-character offsets from a unique high-confidence match", () => {
    const source = "The calibrated value is �, while every other source byte stays fixed.";
    const result = alignMinerUReplacementCharactersToPdfText(
      source,
      "Unrelated header The calibrated value is ν, while every other source byte stays fixed. Footer"
    );

    expect(result.limitExceeded).toBe(false);
    expect(result.recovery).toMatchObject({
      text: source.replace("�", "ν"),
      recoveredCount: 1
    });
    expect(result.recovery!.confidence).toBeGreaterThanOrEqual(0.985);
  });

  it("abstains when the same evidence occurs twice", () => {
    const source = "A uniquely described scalar � closes this sentence.";
    const recovered = source.replace("�", "τ");
    const result = alignMinerUReplacementCharactersToPdfText(source, `${recovered} ${recovered}`);

    expect(result.limitExceeded).toBe(false);
    expect(result.recovery).toBeUndefined();
  });

  it("abstains on Markdown-active replacements and unrelated low-confidence text", () => {
    const source = "The selected label � belongs here.";

    expect(alignMinerUReplacementCharactersToPdfText(
      source,
      source.replace("�", "*")
    ).recovery).toBeUndefined();
    expect(alignMinerUReplacementCharactersToPdfText(
      source,
      "Nothing in this PDF text resembles the selected MinerU block."
    ).recovery).toBeUndefined();
  });

  it("fails closed before allocating beyond the caller's cell budget", () => {
    const result = alignMinerUReplacementCharactersToPdfText(
      `prefix ${"a".repeat(100)} � suffix`,
      `prefix ${"a".repeat(100)} ν suffix`,
      100
    );

    expect(result).toEqual({ cellsEvaluated: 0, limitExceeded: true });
  });
});
