import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("figure sidebar layout", () => {
  it("keeps the image region in normal flow when a long caption makes the stage scroll", () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    const imageButtonRule = stylesheet.match(/\.p2md-figure-image-button\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(imageButtonRule).toMatch(/flex:\s*0\s+0\s+auto\s*;/);
  });
});
