import { describe, expect, it } from "vitest";
import { RemotePackageReaderFileSystem } from "../apps/web/src/remote-package-reader-file-system";

describe("remote package file-system probing", () => {
  const fileSystem = new RemotePackageReaderFileSystem("Clipping", "http://127.0.0.1:8787/api/v1", "package-1", [
    { path: "article.md", size: 10, sha256: "0".repeat(64) },
    { path: "images/figure-0001.png", size: 3, sha256: "1".repeat(64) }
  ]);

  it("returns false for safe optional files while rejecting unsafe paths", async () => {
    await expect(fileSystem.exists("mineru-result.json")).resolves.toBe(false);
    await expect(fileSystem.fileInfo("_paper2md/reader.json")).resolves.toBeUndefined();
    expect(fileSystem.resolvePath("_paper2md/reader.json")).toBe("Clipping/_paper2md/reader.json");
    await expect(fileSystem.exists("../secret")).rejects.toThrow("Unsafe package path");
  });

  it("lists known files inside a virtual directory that has no descriptor entry", async () => {
    await expect(fileSystem.listFiles("images")).resolves.toEqual(["images/figure-0001.png"]);
  });
});
