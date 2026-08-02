import { describe, expect, it } from "vitest";
import {
  derivePackageState,
  expectedAnchorIds,
  isSafeRelativePath,
  normalizeContract,
  parseAnchorInventory
} from "../src/model/contract-validation";
import { cloneContract, HASHES, IDS, makeArticle, makeContract } from "./reader-fixture";

describe("parseAnchorInventory", () => {
  it("collects public block and slot anchors and reports duplicates", () => {
    const markdown = `${makeArticle()}\n<!-- p2md:block id="${IDS.body}" kind="body" -->`;
    const inventory = parseAnchorInventory(markdown);
    expect(inventory.blockIds).toEqual([IDS.title, IDS.body, IDS.caption, IDS.body]);
    expect(inventory.slotIds).toEqual([IDS.slot]);
    expect(inventory.duplicateIds).toEqual([IDS.body]);
    expect(inventory.malformedMarkers).toEqual([]);
    expect(inventory.blockKinds.get(IDS.caption)).toBe("caption");
    expect(inventory.slotAssets.get(IDS.slot)).toBe(IDS.asset);
  });

  it("does not silently accept malformed Paper2MD markers", () => {
    const inventory = parseAnchorInventory('<!-- p2md:block id="blk_short" kind="body" -->');
    expect(inventory.blockIds).toEqual([]);
    expect(inventory.malformedMarkers).toEqual(["line 1"]);
  });
});

describe("isSafeRelativePath", () => {
  it("accepts package-relative paths and rejects traversal or absolute paths", () => {
    expect(isSafeRelativePath("images/figure-0001.png")).toBe(true);
    expect(isSafeRelativePath("../outside.png")).toBe(false);
    expect(isSafeRelativePath("C:\\outside.png")).toBe(false);
    expect(isSafeRelativePath("/outside.png")).toBe(false);
  });
});

describe("normalizeContract", () => {
  it("normalizes the v0.1 graph and derives expected slot anchors", () => {
    const result = normalizeContract(makeContract());
    expect(result.diagnostics).toEqual([]);
    expect(result.contract).toBeDefined();
    const expected = expectedAnchorIds(result.contract!);
    expect([...expected.blocks]).toEqual([IDS.title, IDS.body, IDS.caption]);
    expect([...expected.slots]).toEqual([IDS.slot]);
  });

  it("rejects the obsolete Reader draft shape", () => {
    const result = normalizeContract({
      contract_version: "paper2md-reader-v0.1",
      source_sha256: HASHES.source,
      article: { path: "article.md", sha256: HASHES.article, anchor_contract_version: "p2md-anchors-v0.1" },
      capabilities: {},
      blocks: [],
      assets: [{ placement_slot_ids: [IDS.slot] }],
      relations: [{ source: IDS.slot, target: IDS.asset }]
    });
    expect(result.contract).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "invalid-article")).toBe(true);
  });

  it("rejects graph identities that disagree", () => {
    const contract = cloneContract();
    contract.assets[0].placement_block_id = "slot_888888888888888888888888";
    const result = normalizeContract(contract);
    expect(result.contract).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "invalid-asset-placement")).toBe(true);
  });
});

describe("derivePackageState", () => {
  it("distinguishes valid, edited, missing and ambiguous anchors", () => {
    const contract = makeContract();
    const anchors = parseAnchorInventory(makeArticle());
    expect(derivePackageState(contract, [], HASHES.article, anchors)).toBe("valid");
    expect(derivePackageState(contract, [], "0".repeat(64), anchors)).toBe("edited-with-anchors");

    const missing = parseAnchorInventory(makeArticle().replace(
      `<!-- p2md:block id="${IDS.caption}" kind="caption" -->\n`,
      ""
    ));
    expect(derivePackageState(contract, [], HASHES.article, missing)).toBe("recoverable");

    const wrongAsset = parseAnchorInventory(makeArticle().replace(IDS.asset, "ast_999999999999999999999999"));
    expect(derivePackageState(contract, [], HASHES.article, wrongAsset)).toBe("ambiguous");
  });
});
