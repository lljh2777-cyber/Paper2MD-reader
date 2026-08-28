import { describe, expect, it } from "vitest";
import { parseSafeCaptionMarkup } from "../src/render/caption-markup";

describe("safe caption markup", () => {
  it("projects only bounded sup and sub markup", () => {
    expect(parseSafeCaptionMarkup("10<sup>9</sup> and H<sub>2</sub>O")).toEqual([
      { kind: "text", text: "10" },
      { kind: "sup", text: "9" },
      { kind: "text", text: " and H" },
      { kind: "sub", text: "2" },
      { kind: "text", text: "O" }
    ]);
  });

  it("keeps arbitrary or malformed HTML literal", () => {
    expect(parseSafeCaptionMarkup("<img src=x onerror=alert(1)> <sup>open")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)> <sup>open" }
    ]);
  });
});
