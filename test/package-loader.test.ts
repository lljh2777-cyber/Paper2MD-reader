import { describe, expect, it } from "vitest";
import { PackageLoader } from "../src/model/package-loader";
import { HASHES, makeArticle, makeContract } from "./reader-fixture";
import { MemoryReaderFileSystem } from "./memory-reader-file-system";

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("PackageLoader host abstraction", () => {
  it("loads a valid package through a host-neutral file system", async () => {
    const article = makeArticle();
    const image = new Uint8Array([137, 80, 78, 71]);
    const contract = makeContract();
    contract.article.sha256 = await sha256(article);
    contract.assets[0].sha256 = await sha256(image);
    contract.assets[0].size_bytes = image.byteLength;

    const fileSystem = new MemoryReaderFileSystem({
      "article.md": article,
      "_paper2md/reader.json": JSON.stringify(contract),
      "images/figure-0001.png": image
    });
    const loaded = await new PackageLoader(fileSystem).load();

    expect(loaded.state).toBe("valid");
    expect(loaded.assets).toEqual([expect.objectContaining({ exists: true, integrityMatches: true })]);
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ code: "manifest-missing", level: "warning" })]);
  });

  it("uses a filename-only image list when reader.json is absent", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# Local fallback",
      "images/figure-0002.png": new Uint8Array([1, 2, 3]),
      "images/readme.txt": "ignored"
    });
    const loaded = await new PackageLoader(fileSystem).load();

    expect(loaded.state).toBe("reader-missing");
    expect(loaded.assets.map((asset) => asset.path)).toEqual(["images/figure-0002.png"]);
  });

  it("rejects traversal before reading from the selected package", async () => {
    const fileSystem = new MemoryReaderFileSystem({ "article.md": "# Safe" });
    await expect(new PackageLoader(fileSystem).load("../article.md")).rejects.toThrow("Unsafe article path");
  });

  it("keeps unsupported versions in safe fallback mode", async () => {
    const fileSystem = new MemoryReaderFileSystem({
      "article.md": "# Future",
      "_paper2md/reader.json": JSON.stringify({ contract_version: "paper2md-reader-v9.0", source_sha256: HASHES.source })
    });
    const loaded = await new PackageLoader(fileSystem).load();
    expect(loaded.state).toBe("unsupported-version");
    expect(loaded.contract).toBeUndefined();
  });
});
