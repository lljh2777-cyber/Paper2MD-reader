import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { BrowserDirectoryReaderFileSystem } from "../src/filesystem/browser-directory-reader-file-system";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import { PackageLoader } from "../src/model/package-loader";

const contentList = [{
  type: "image",
  img_path: "images/figure.png",
  image_caption: ["Figure 1. Browser projection."],
  page_idx: 0
}];

function archive(entries: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "result/full.md": strToU8("# MinerU paper\n\n![](images/figure.png)\n\nFigure 1. Browser projection.\n"),
    "result/job_content_list.json": strToU8(JSON.stringify(contentList)),
    "result/job_content_list_v2.json": strToU8(JSON.stringify([[{ type: "text", content: "v2" }]])),
    "result/layout.json": strToU8("{}"),
    "result/images/figure.png": new Uint8Array([137, 80, 78, 71]),
    ...entries
  });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("browser MinerU archive projection", () => {
  it("validates one wrapped MinerU root, preserves source bytes and loads the projected package", async () => {
    const source = archive();
    const before = source.slice();
    const extracted = extractMinerUArchiveForReader(source);

    expect(source).toEqual(before);
    expect(extracted.rootPrefix).toBe("result/");
    expect(extracted.articlePath).toBe("full.md");
    expect(extracted.contentListPath).toBe("job_content_list.json");
    expect([...extracted.files.keys()]).toEqual(expect.arrayContaining([
      "full.md",
      "job_content_list.json",
      "job_content_list_v2.json",
      "layout.json",
      "images/figure.png"
    ]));

    const sourceArchive = new File([arrayBuffer(source)], "paper.mineru.zip", { type: "application/zip" });
    const files = new Map<string, File>();
    for (const [path, bytes] of extracted.files) {
      files.set(path, new File([arrayBuffer(bytes)], path.split("/").at(-1)!, { type: "application/octet-stream" }));
    }
    const fileSystem = BrowserDirectoryReaderFileSystem.fromMinerUArchive("paper", files, {
      format: "mineru-zip",
      sourceArchive,
      sourceRootPrefix: extracted.rootPrefix,
      articlePath: extracted.articlePath,
      contentListPath: extracted.contentListPath,
      fileCount: extracted.fileCount,
      markdownCount: extracted.markdownCount,
      jsonCount: extracted.jsonCount,
      imageCount: extracted.imageCount
    });
    const loaded = await new PackageLoader(fileSystem).loadDetected();

    expect(loaded.state).toBe("mineru");
    expect(loaded.sourceFormat).toBe("mineru");
    expect(loaded.articleText).toContain("Figure 1. Browser projection.");
    expect(fileSystem.sourceArchive?.sourceArchive).toBe(sourceArchive);
    expect(new Uint8Array(await fileSystem.sourceArchive!.sourceArchive.arrayBuffer())).toEqual(before);
  });

  it("fails closed when a file sits outside the unique Markdown root", () => {
    expect(() => extractMinerUArchiveForReader(archive({ "top-level.json": strToU8("{}") })))
      .toThrow(/唯一论文根目录/);
  });

  it("fails closed when the content list is nested below the Markdown directory", () => {
    const source = zipSync({
      "result/full.md": strToU8("# MinerU paper"),
      "result/metadata/job_content_list.json": strToU8("[]")
    });
    expect(() => extractMinerUArchiveForReader(source)).toThrow(/唯一论文根目录/);
  });
});
