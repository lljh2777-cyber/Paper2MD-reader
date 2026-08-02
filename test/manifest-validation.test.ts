import { describe, expect, it } from "vitest";
import { validateManifestBinding } from "../src/model/manifest-validation";
import {
  HYBRID_MANIFEST_VERSION,
  MARKDOWN_ANCHOR_CONTRACT_VERSION,
  READER_CONTRACT_VERSION
} from "../src/model/reader-contract";
import { HASHES, makeContract } from "./reader-fixture";

function makeManifest() {
  return {
    manifest_version: HYBRID_MANIFEST_VERSION,
    source_sha256: HASHES.source,
    reader: {
      contract_version: READER_CONTRACT_VERSION,
      path: "_paper2md/reader.json",
      sha256: HASHES.reader,
      article_path: "article.md",
      article_sha256: HASHES.article,
      anchor_contract: MARKDOWN_ANCHOR_CONTRACT_VERSION
    },
    outputs: [
      { path: "article.md", role: "markdown", sha256: HASHES.article },
      { path: "_paper2md/reader.json", role: "reader_index", sha256: HASHES.reader }
    ]
  };
}

describe("validateManifestBinding", () => {
  it("accepts the Paper2MD manifest v0.8 reader binding", () => {
    expect(validateManifestBinding(makeManifest(), makeContract(), HASHES.reader)).toEqual([]);
  });

  it("rejects a reader hash that does not match the manifest", () => {
    const diagnostics = validateManifestBinding(makeManifest(), makeContract(), "0".repeat(64));
    expect(diagnostics.some((item) => item.code === "manifest-reader-hash-mismatch")).toBe(true);
  });

  it("warns, but does not invent a binding for older manifests", () => {
    const diagnostics = validateManifestBinding(
      { manifest_version: "paper2md-manifest-v0.7" },
      makeContract(),
      HASHES.reader
    );
    expect(diagnostics).toEqual([expect.objectContaining({ level: "warning", code: "unsupported-manifest-version" })]);
  });

  it("rejects unknown future manifest semantics", () => {
    const diagnostics = validateManifestBinding(
      { manifest_version: "paper2md-manifest-v0.9" },
      makeContract(),
      HASHES.reader
    );
    expect(diagnostics).toEqual([expect.objectContaining({ level: "error", code: "unsupported-manifest-version" })]);
  });

  it("rejects ambiguous duplicate output bindings", () => {
    const manifest = makeManifest();
    manifest.outputs.push({ path: "_paper2md/reader.json", role: "reader_index", sha256: HASHES.reader });
    const diagnostics = validateManifestBinding(manifest, makeContract(), HASHES.reader);
    expect(diagnostics.some((item) => item.code === "manifest-reader-output-mismatch")).toBe(true);
  });
});
