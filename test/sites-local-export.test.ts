import { describe, expect, it } from "vitest";
import {
  type DirectoryHandleLike,
  writePackageToFreshDirectory
} from "../apps/web/src/browser-directory-export";

function handleError(name: "NotFoundError" | "TypeMismatchError"): DOMException {
  return new DOMException(name, name);
}

class MemoryFileHandle {
  constructor(readonly record: { data?: Blob; writes: number }) {}

  async getFile(): Promise<File> {
    return new File([this.record.data ?? new Blob()], "memory-file");
  }

  async createWritable() {
    return {
      write: async (data: Blob) => { this.record.writes += 1; this.record.data = data; },
      close: async () => undefined,
      abort: async () => undefined
    };
  }
}

class MemoryDirectory implements DirectoryHandleLike {
  readonly directories = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, { data?: Blob; writes: number }>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    if (this.files.has(name)) throw handleError("TypeMismatchError");
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw handleError("NotFoundError");
    const directory = new MemoryDirectory();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    if (this.directories.has(name)) throw handleError("TypeMismatchError");
    const existing = this.files.get(name);
    if (existing) return new MemoryFileHandle(existing);
    if (!options?.create) throw handleError("NotFoundError");
    const record = { writes: 0 };
    this.files.set(name, record);
    return new MemoryFileHandle(record);
  }
}

describe("Sites fresh local-directory export", () => {
  it("allocates a fresh folder and never reuses an existing result", async () => {
    const root = new MemoryDirectory();
    const existing = await root.getDirectoryHandle("paper-old", { create: true });
    const oldFile = await existing.getFileHandle("article.md", { create: true });
    const oldWritable = await oldFile.createWritable();
    await oldWritable.write(new Blob(["old"]));
    await oldWritable.close();
    const nonces = ["old", "fresh"];

    const result = await writePackageToFreshDirectory(root, "paper", new Map([
      ["article.md", new File(["new"], "article.md")],
      ["_extraction/source.pdf", new File(["pdf"], "source.pdf", { type: "application/pdf" })]
    ]), () => nonces.shift()!);

    expect(result).toEqual({ folderName: "paper-fresh", fileCount: 2 });
    expect(await existing.files.get("article.md")!.data!.text()).toBe("old");
    expect(existing.files.get("article.md")!.writes).toBe(1);
    const fresh = root.directories.get("paper-fresh")!;
    expect(await fresh.files.get("article.md")!.data!.text()).toBe("new");
    expect(await fresh.directories.get("_extraction")!.files.get("source.pdf")!.data!.text()).toBe("pdf");
  });

  it("rejects file-directory and canonical path collisions before creating an output folder", async () => {
    const root = new MemoryDirectory();
    await expect(writePackageToFreshDirectory(root, "paper", new Map([
      ["images", new File(["file"], "images")],
      ["images/figure.png", new File(["image"], "figure.png")]
    ]), () => "fresh")).rejects.toThrow(/文件与目录冲突/);
    expect(root.directories.size).toBe(0);

    await expect(writePackageToFreshDirectory(root, "paper", new Map([
      ["Figure.md", new File(["a"], "Figure.md")],
      ["figure.md", new File(["b"], "figure.md")]
    ]), () => "fresh")).rejects.toThrow(/本地冲突/);
    expect(root.directories.size).toBe(0);

    await expect(writePackageToFreshDirectory(root, "paper", new Map([
      ["Images/a.png", new File(["a"], "a.png")],
      ["images/b.png", new File(["b"], "b.png")]
    ]), () => "fresh")).rejects.toThrow(/目录发生本地冲突/);
    expect(root.directories.size).toBe(0);
  });
});
