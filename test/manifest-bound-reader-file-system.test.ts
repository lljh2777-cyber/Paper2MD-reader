import { afterEach, describe, expect, it, vi } from "vitest";
import type { AfterMinerUFileRecord } from "../packages/after-mineru-contract/src/index";
import { sha256Bytes } from "../packages/after-mineru-contract/src/index";
import { ManifestBoundReaderFileSystem } from "../src/filesystem/manifest-bound-reader-file-system";
import type { ReaderFileInfo, ReaderFileSystem } from "../src/filesystem/reader-file-system";

class MutableReaderFileSystem implements ReaderFileSystem {
  readonly rootLabel = "mutable";
  readonly dispose = vi.fn();

  constructor(private readonly files: Map<string, Uint8Array>) {}

  set(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }

  resolvePath(path: string): string { return `mutable/${path}`; }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async fileInfo(path: string): Promise<ReaderFileInfo | undefined> {
    const bytes = this.files.get(path);
    return bytes ? { size: bytes.byteLength } : undefined;
  }
  async readText(path: string): Promise<string> { return new TextDecoder().decode(await this.bytes(path)); }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = await this.bytes(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async listFiles(directory: string): Promise<string[]> {
    const prefix = directory ? `${directory}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  }
  async resolveAssetUrl(path: string): Promise<string> { return `source://${path}`; }

  private async bytes(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    return bytes.slice();
  }
}

function record(path: string, bytes: Uint8Array): AfterMinerUFileRecord {
  return { path, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ManifestBoundReaderFileSystem", () => {
  it("exposes only manifest records and aliases and revalidates every byte read", async () => {
    const article = new TextEncoder().encode("safe");
    const alias = new Uint8Array([1, 2, 3, 4]);
    const source = new MutableReaderFileSystem(new Map([
      ["derived/article.md", article],
      ["images/figure.png", alias],
      ["unlisted.png", new Uint8Array([9])]
    ]));
    const bound = new ManifestBoundReaderFileSystem(source, [
      record("derived/article.md", article),
      record("images/figure.png", alias)
    ]);

    expect(await bound.readText("derived/article.md")).toBe("safe");
    expect(new Uint8Array(await bound.readBinary("images/figure.png"))).toEqual(alias);
    expect(await bound.exists("unlisted.png")).toBe(false);
    expect(() => bound.resolvePath("unlisted.png")).toThrow(/not bound/);
    await expect(bound.fileInfo("unlisted.png")).rejects.toThrow(/not bound/);
    expect(await bound.listFiles("images")).toEqual(["images/figure.png"]);

    source.set("derived/article.md", new TextEncoder().encode("evil"));
    await expect(bound.readText("derived/article.md")).rejects.toThrow(/bytes changed/);
    source.set("images/figure.png", new Uint8Array([1, 2, 3]));
    await expect(bound.readBinary("images/figure.png")).rejects.toThrow(/size changed/);

    bound.dispose();
    expect(source.dispose).not.toHaveBeenCalled();
  });

  it("decodes manifest-bound text as fatal UTF-8", async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const source = new MutableReaderFileSystem(new Map([["derived/article.md", invalidUtf8]]));
    const bound = new ManifestBoundReaderFileSystem(source, [record("derived/article.md", invalidUtf8)]);

    await expect(bound.readText("derived/article.md")).rejects.toThrow(/not valid UTF-8/);
  });

  it("creates asset URLs only from reverified Blob bytes and revokes them on dispose", async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    const source = new MutableReaderFileSystem(new Map([["images/figure.png", image]]));
    const createObjectURL = vi.fn((_blob: Blob) => "blob:verified-figure");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bound = new ManifestBoundReaderFileSystem(source, [record("images/figure.png", image)]);

    expect(await bound.resolveAssetUrl("images/figure.png")).toBe("blob:verified-figure");
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(image);

    bound.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:verified-figure");
  });
});
