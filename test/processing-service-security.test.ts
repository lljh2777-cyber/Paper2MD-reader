import { describe, expect, it } from "vitest";
import { loadProcessingServiceConfig, parseMineruOptions } from "../apps/processing-service/src/config";
import { safePdfFilename } from "../apps/processing-service/src/job-manager";
import { mineruExtractArgs, mineruSpawnSpec, runMineru } from "../apps/processing-service/src/mineru-runner";
import { flattenMineruElements, normalizePackagePath } from "../apps/processing-service/src/package-publisher";
import { resolve } from "node:path";

describe("standalone processing service security", () => {
  it("requires authentication before binding beyond loopback", () => {
    expect(() => loadProcessingServiceConfig({ PAPER2MD_SERVICE_HOST: "0.0.0.0" })).toThrow("SERVICE_TOKEN");
    expect(loadProcessingServiceConfig({
      PAPER2MD_SERVICE_HOST: "0.0.0.0",
      PAPER2MD_SERVICE_TOKEN: "test-only-secret"
    }).host).toBe("0.0.0.0");
  });

  it("accepts only declared MinerU model and language options", () => {
    expect(parseMineruOptions({ "x-paper2md-model": "vlm", "x-paper2md-language": "en" }, 900)).toEqual({
      model: "vlm",
      language: "en",
      timeoutSeconds: 900
    });
    expect(() => parseMineruOptions({ "x-paper2md-model": "../../shell" }, 900)).toThrow("model");
    expect(() => parseMineruOptions({ "x-paper2md-language": "anything" }, 900)).toThrow("language");
  });

  it("builds only precision extract md,json arguments", () => {
    const args = mineruExtractArgs("C:\\jobs\\source.pdf", "C:\\jobs\\extract", {
      model: "pipeline",
      language: "en",
      timeoutSeconds: 600
    });
    expect(args.slice(0, 2)).toEqual(["extract", "C:\\jobs\\source.pdf"]);
    expect(args).toContain("md,json");
    expect(args).toContain("--formula");
    expect(args).toContain("--table");
    expect(args).not.toContain("flash-extract");
  });

  it("uses the configured Windows command processor only for a fixed cmd shim", () => {
    const spec = mineruSpawnSpec("C:\\tools\\mineru-open-api.cmd", ["extract", "C:\\jobs\\source.pdf"]);
    if (process.platform === "win32") {
      expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(spec.args[3]).toContain('"C:\\tools\\mineru-open-api.cmd"');
      expect(spec.args[3]).toContain('"extract"');
      expect(spec.args[3].startsWith('""')).toBe(true);
      expect(spec.args[3].endsWith('""')).toBe(true);
      expect(spec.windowsVerbatimArguments).toBe(true);
    } else {
      expect(spec).toEqual({ command: "C:\\tools\\mineru-open-api.cmd", args: ["extract", "C:\\jobs\\source.pdf"] });
    }
  });

  it.skipIf(process.platform !== "win32")("executes a cmd shim when its path and argument contain spaces", async () => {
    const fixture = resolve("test", "fixtures", "mineru shim.cmd");
    await expect(runMineru(fixture, ["hello world"], process.cwd(), 60)).resolves.toContain("hello world");
  });

  it("normalizes upload names without allowing directory selection", () => {
    expect(safePdfFilename(encodeURIComponent("C:\\papers\\A paper.pdf"))).toBe("A paper.pdf");
    expect(() => safePdfFilename("paper.txt")).toThrow("PDF");
  });

  it("rejects remote, absolute and traversal package resources", () => {
    expect(normalizePackagePath("images/figure%201.png")).toBe("images/figure 1.png");
    for (const path of ["../secret.png", "/etc/passwd", "https://example.com/a.png", "images/%2e%2e/a.png"]) {
      expect(() => normalizePackagePath(path)).toThrow("Unsafe");
    }
  });

  it("flattens MinerU v1 and page-nested v2 without inventing page data", () => {
    expect(flattenMineruElements([{ type: "text", page_idx: 3 }])[0].pageIndex).toBe(3);
    expect(flattenMineruElements([[{ type: "text" }], [{ type: "image" }]])).toEqual([
      expect.objectContaining({ pageIndex: 0 }),
      expect.objectContaining({ pageIndex: 1 })
    ]);
    expect(() => flattenMineruElements([])).toThrow("non-empty");
  });
});
