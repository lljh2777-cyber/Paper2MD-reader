import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  extractMarkdownImageOccurrences
} from "../apps/processing-service/src/reader-contract-generator";

const repositoryRoot = resolve(import.meta.dirname, "..");
const hashes = { article: "a".repeat(64), mineru_result: "b".repeat(64) };
const viewerOptions = { packagedSourcePdf: true, sourceAvailableAtGeneration: true };

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(repositoryRoot, "test", "fixtures", "reader-contract-review", name), "utf8")) as Record<string, unknown>;
}

describe("reader-contract resource limits", () => {
  it("rejects the 8193rd source element before allocating the flattened copy", () => {
    let mapped = false;
    const payload = new Proxy(new Array<unknown>(8193).fill(null), {
      get(target, property, receiver) {
        if (property === "map") mapped = true;
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(() => buildMineruViewerIndex(payload, [], hashes, viewerOptions)).toThrow("element limit");
    expect(mapped).toBe(false);
  });

  it("rejects excessive empty v2 pages before the publisher can flatten them on the host thread", () => {
    expect(() => buildMineruViewerIndex(Array.from({ length: 2049 }, () => []), [], hashes, viewerOptions)).toThrow("page limit");
  });

  it("rejects over-deep nested text with a deterministic error instead of overflowing the stack", () => {
    let text: unknown = "caption";
    for (let depth = 0; depth < 65; depth += 1) text = [text];
    const payload = [{ type: "text", page_idx: 0, bbox: [0, 0, 10, 10], text }];
    expect(() => buildMineruViewerIndex(payload, [], hashes, viewerOptions)).toThrow("nesting limit");
  });

  it("rejects too many nested text values during traversal", () => {
    const payload = [{
      type: "text",
      page_idx: 0,
      bbox: [0, 0, 10, 10],
      text: Array.from({ length: 8193 }, (_, index) => String(index))
    }];
    expect(() => buildMineruViewerIndex(payload, [], hashes, viewerOptions)).toThrow("string limit");
  });

  it("accepts 4096 normalized image references and rejects the next one during scanning", () => {
    const accepted = Array.from({ length: 4096 }, (_, index) => `![${index}](images/${index}.png)`).join("\n");
    expect(extractMarkdownImageOccurrences(accepted)).toHaveLength(4096);
    expect(() => extractMarkdownImageOccurrences(`${accepted}\n<img src="images/overflow.png">`)).toThrow("image limit");
  });

  it("accepts 128 unique candidates, rejects the 129th, and keeps exact duplicates deduplicated", async () => {
    const viewer = await fixture("expected-viewer-index.json");
    const repair = await fixture("expected-visual-repair.json");
    const sourceGroup = (repair.groups as Record<string, unknown>[])[0];
    const groups = Array.from({ length: 129 }, (_, index) => ({ ...structuredClone(sourceGroup), id: `vr-p0000-g${String(index).padStart(4, "0")}` }));
    const groupOnlyRepair = { ...repair, caption_links: [], issues: [] };

    expect((buildMineruVisualCandidates(viewer, { ...groupOnlyRepair, groups: groups.slice(0, 128) }).candidates as unknown[])).toHaveLength(128);
    expect(() => buildMineruVisualCandidates(viewer, { ...groupOnlyRepair, groups })).toThrow("review-candidate limit");
    expect((buildMineruVisualCandidates(viewer, { ...groupOnlyRepair, groups: new Array(129).fill(sourceGroup) }).candidates as unknown[])).toHaveLength(1);
  });

  it("rejects an over-budget caption-key set before enumerating review candidates", async () => {
    const viewer = structuredClone(await fixture("expected-viewer-index.json"));
    const repair = await fixture("expected-visual-repair.json");
    const pages = viewer.pages as Array<{ blocks: Array<Record<string, unknown>> }>;
    const source = pages[1].blocks[0];
    const target = pages[2].blocks[0];
    const keys = Array.from({ length: 129 }, (_, index) => `figure:${index}`);
    source.caption = { ...(source.caption as Record<string, unknown>), figure_keys: keys, next_page_figure_keys: keys };
    target.text = { ...(target.text as Record<string, unknown>), formal_figure_caption_keys: keys };
    const ambiguousRepair = {
      ...repair,
      groups: [],
      caption_links: [],
      issues: [{
        code: "ambiguous_next_page_caption",
        visual_block_id: "p0001-s000003",
        source_page_idx: 1,
        target_page_idx: 2
      }]
    };
    expect(() => buildMineruVisualCandidates(viewer, ambiguousRepair)).toThrow("caption-key limit");
  });
});
