import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import {
  buildMineruViewerIndex,
  buildMineruVisualCandidates,
  buildMineruVisualRepair,
  extractMarkdownImageOccurrences
} from "../apps/processing-service/src/reader-contract-generator";
import { extractMinerUArchiveForReader } from "../src/model/mineru-archive";
import { prepareMinerUVisualReview } from "../src/model/mineru-visual-review";
import { AFTER_MINERU_DISPLAY_REPAIR_VERSION } from "../packages/after-mineru-contract/src/index";

type FileRecord = { path: string; size: number; sha256: string };
type UnknownRecord = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const demoRoot = resolve(repositoryRoot, "sites-reader", "public", "demo", "debyecalculator");
const sourcePath = resolve(demoRoot, "source.pdf");
const rawArchivePath = resolve(demoRoot, "mineru-original.mineru.zip");
const fixedTimestamp = "2026-08-29T00:00:00.000Z";
const zipTimestamp = new Date("2026-08-29T00:00:00.000Z");
const sourcePdfSha256 = "88da42c642b5d651140110d1379ab7d2401bfc2443e9179b39077109e2f42e7f";

const sourceVerifiedDisplayRepairs = [
  {
    id: "body-equation-symbols",
    target: "article",
    sourceBlockId: "p0000-s000019",
    pageIndex: 0,
    source: "radiation, � is the number of atoms in the structure, and $r _ { \\nu \\mu }$ is the distance between atoms � and $\\mu .$ For X-ray radiation, the atomic form factor, $b ,$ depends strongly on $Q$ and is usually denoted as $f ( Q )$ , but for neutrons, � is independent",
    repaired: "radiation, $N$ is the number of atoms in the structure, and $r _ { \\nu \\mu }$ is the distance between atoms $\\nu$ and $\\mu .$ For X-ray radiation, the atomic form factor, $b ,$ depends strongly on $Q$ and is usually denoted as $f ( Q )$ , but for neutrons, $b$ is independent"
  },
  {
    id: "body-figure-2-symbols",
    target: "article",
    sourceBlockId: "p0002-s000047",
    pageIndex: 2,
    source: "where users can calculate �(�), �(�), �(�), and �(�) from structural models",
    repaired: "where users can calculate $I(Q)$, $S(Q)$, $F(Q)$, and $G(r)$ from structural models"
  },
  {
    id: "caption-figure-2",
    target: "caption",
    sourceBlockId: "p0003-s000051",
    pageIndex: 3,
    source: "Figure 2: The interact mode of DebyeCalculator provides a one-click interface, where the user can update parameters and visualise �(�), �(�), �(�), and �(�). Additionally, the �(�), �(�), �(�), �(�), and .xyz file can be downloaded, including metadata.",
    repaired: "Figure 2: The interact mode of DebyeCalculator provides a one-click interface, where the user can update parameters and visualise $I(Q)$, $S(Q)$, $F(Q)$, and $G(r)$. Additionally, the $I(Q)$, $S(Q)$, $F(Q)$, $G(r)$, and .xyz file can be downloaded, including metadata."
  },
  {
    id: "caption-figure-3",
    target: "caption",
    sourceBlockId: "p0004-s000061",
    pageIndex: 4,
    source: "Figure 3: Comparison of the calculated �(�), SAXS, �(�), and �(�) of DebyeCalculator and DifPy-CMI (Juhás et al., 2015) on a discrete, spherical cutout with 6 Å in radius from $\\textsf { a V } _ { 0 . 9 8 5 } \\mathsf { A l } _ { 0 . 0 1 5 } \\mathsf { O } _ { 2 }$ crystal (Ghedira et al., 1977).",
    repaired: "Figure 3: Comparison of the calculated $I(Q)$, SAXS, $F(Q)$, and $G(r)$ of DebyeCalculator and DiffPy-CMI (Juhás et al., 2015) on a discrete, spherical cutout with 6 Å in radius from a $\\mathrm{V}_{0.985}\\mathrm{Al}_{0.015}\\mathrm{O}_{2}$ crystal (Ghedira et al., 1977)."
  }
] as const satisfies ReadonlyArray<{
  id: string;
  target: "article" | "caption";
  sourceBlockId: string;
  pageIndex: number;
  source?: string;
  raw?: string;
  repaired: string;
}>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`);
}

function fileRecord(path: string, data: Uint8Array): FileRecord {
  return { path, size: data.byteLength, sha256: sha256(data) };
}

function summary(value: UnknownRecord): UnknownRecord {
  const candidate = value.summary;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as UnknownRecord
    : {};
}

function pageCount(contentList: unknown): number {
  if (!Array.isArray(contentList)) return 0;
  const pages = contentList.flatMap((value, index) => Array.isArray(value)
    ? value.map(() => index)
    : [typeof value === "object" && value && Number.isInteger((value as UnknownRecord).page_idx)
      ? Number((value as UnknownRecord).page_idx)
      : 0]);
  return pages.length ? Math.max(...pages) + 1 : 0;
}

function buildSourceVerifiedDemoDisplayRepair(input: {
  viewerIndex: unknown;
  contentList: unknown;
  article: string;
  articleHash: string;
  contentListHash: string;
  actualSourcePdfSha256: string;
}): UnknownRecord {
  const { viewerIndex, contentList, article, articleHash, contentListHash, actualSourcePdfSha256 } = input;
  if (actualSourcePdfSha256 !== sourcePdfSha256) {
    throw new Error("The source PDF hash does not authorize the demo display repairs.");
  }
  const root = viewerIndex as UnknownRecord;
  const pages = Array.isArray(root.pages) ? root.pages : [];
  const rawRecords = Array.isArray(contentList)
    ? contentList.flatMap((value) => Array.isArray(value) ? value : [value])
    : [];
  const repairs = sourceVerifiedDisplayRepairs.map((repair) => {
    const matches = pages.flatMap((pageValue, pageFallback) => {
      if (!pageValue || typeof pageValue !== "object" || Array.isArray(pageValue)) return [];
      const page = pageValue as UnknownRecord;
      const blocks = Array.isArray(page.blocks) ? page.blocks : [];
      return blocks.flatMap((blockValue) => {
        if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) return [];
        const block = blockValue as UnknownRecord;
        return block.id === repair.sourceBlockId
          ? [{ block, pageIndex: Number(page.page_idx ?? pageFallback) }]
          : [];
      });
    });
    const sourceText = repair.source;
    if (matches.length !== 1 || matches[0].pageIndex !== repair.pageIndex || !sourceText) {
      throw new Error(`A source-verified display repair did not match exactly one Viewer block: ${repair.id}`);
    }
    const sourceIndex = Number(matches[0].block.source_index);
    const rawRecord = Number.isInteger(sourceIndex) && rawRecords[sourceIndex]
      && typeof rawRecords[sourceIndex] === "object" && !Array.isArray(rawRecords[sourceIndex])
      ? rawRecords[sourceIndex] as UnknownRecord
      : undefined;
    if (!rawRecord) throw new Error(`A display repair has no MinerU source record: ${repair.id}`);
    if (repair.target === "article") {
      if (typeof rawRecord.text !== "string" || !rawRecord.text.includes(sourceText)) {
        throw new Error(`An article repair is not bound to its MinerU text block: ${repair.id}`);
      }
    } else {
      const caption = matches[0].block.caption && typeof matches[0].block.caption === "object" && !Array.isArray(matches[0].block.caption)
        ? matches[0].block.caption as UnknownRecord
        : {};
      const captionMatches = Array.isArray(caption.items)
        ? caption.items.filter((item) => item && typeof item === "object" && !Array.isArray(item) && (item as UnknownRecord).text === sourceText)
        : [];
      if (captionMatches.length !== 1) throw new Error(`A caption repair is not bound to one raw caption: ${repair.id}`);
    }
    const first = article.indexOf(sourceText);
    if (first < 0 || article.indexOf(sourceText, first + sourceText.length) >= 0) {
      throw new Error(`A display repair source is not unique in Markdown: ${repair.id}`);
    }
    return {
      id: repair.id,
      target: repair.target,
      source_block_id: repair.sourceBlockId,
      page_index: repair.pageIndex,
      source_text: sourceText,
      replacement_markdown: repair.repaired,
      source_text_sha256: sha256(utf8(sourceText)),
      replacement_markdown_sha256: sha256(utf8(repair.repaired))
    };
  });
  const before = repairs.reduce((sum, repair) => sum + repair.source_text.split("�").length - 1, 0);
  const after = repairs.reduce((sum, repair) => sum + repair.replacement_markdown.split("�").length - 1, 0);
  if (before !== 33 || after !== 0) throw new Error("The source-verified display repair character count is invalid.");
  return {
    schema_version: 1,
    algorithm_version: AFTER_MINERU_DISPLAY_REPAIR_VERSION,
    inputs: {
      article: { sha256: articleHash },
      mineru_result: { sha256: contentListHash },
      source_pdf: { sha256: actualSourcePdfSha256 }
    },
    repairs,
    summary: {
      repair_count: repairs.length,
      article_repair_count: repairs.filter((repair) => repair.target === "article").length,
      caption_repair_count: repairs.filter((repair) => repair.target === "caption").length,
      replacement_characters_before: before,
      replacement_characters_after: after
    }
  };
}

async function main(): Promise<void> {
  if (resolve(process.cwd()) !== repositoryRoot) {
    throw new Error("Run this script from the repository root.");
  }
  const [sourcePdf, rawArchive, attributionBytes] = await Promise.all([
    readFile(sourcePath),
    readFile(rawArchivePath),
    readFile(resolve(demoRoot, "ATTRIBUTION.md"))
  ]);
  if (!sourcePdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The demo source is not a PDF.");
  const extracted = extractMinerUArchiveForReader(rawArchive);
  const articleBytes = extracted.files.get(extracted.articlePath);
  const contentListBytes = extracted.files.get(extracted.contentListPath);
  if (!articleBytes || !contentListBytes) throw new Error("MinerU source files are missing.");
  const article = new TextDecoder("utf-8", { fatal: true }).decode(articleBytes);
  const contentListText = new TextDecoder("utf-8", { fatal: true }).decode(contentListBytes);
  const contentList = JSON.parse(contentListText) as unknown;
  const articleHash = sha256(articleBytes);
  const contentListHash = sha256(contentListBytes);
  const viewerIndex = buildMineruViewerIndex(
    contentList,
    extractMarkdownImageOccurrences(article),
    { article: articleHash, mineru_result: contentListHash },
    { packagedSourcePdf: true, sourceAvailableAtGeneration: true }
  );
  const visualRepair = buildMineruVisualRepair(viewerIndex);
  const visualCandidates = buildMineruVisualCandidates(viewerIndex, visualRepair);
  const viewerBytes = jsonBytes(viewerIndex);
  const repairBytes = jsonBytes(visualRepair);
  const candidateBytes = jsonBytes(visualCandidates);
  const displayRepair = buildSourceVerifiedDemoDisplayRepair({
    viewerIndex,
    contentList,
    article,
    articleHash,
    contentListHash,
    actualSourcePdfSha256: sha256(sourcePdf)
  });
  const displayRepairBytes = jsonBytes(displayRepair);
  const prepared = await prepareMinerUVisualReview({
    candidatePackage: visualCandidates,
    viewerIndex,
    visualRepair,
    articleHash,
    mineruHash: contentListHash,
    mineruPayload: contentList,
    articleMarkdown: article,
    sourcePdfPath: "_extraction/source.pdf",
    candidateFileHash: sha256(candidateBytes)
  });
  if (!prepared.review || prepared.diagnostics.some((item) => item.code === "mineru-visual-review-invalid")) {
    throw new Error("Generated demo contracts failed deterministic validation.");
  }

  const outputs = new Map<string, Uint8Array>();
  for (const [path, data] of [...extracted.files].sort(([left], [right]) => left.localeCompare(right))) {
    outputs.set(path, data);
  }
  outputs.set("_source/mineru-original.mineru.zip", rawArchive);
  const derived = new Map<string, Uint8Array>([
    ["_extraction/viewer-index.json", viewerBytes],
    ["_extraction/visual-repair.json", repairBytes],
    ["_extraction/visual-candidates.json", candidateBytes],
    ["_extraction/display-repair.json", displayRepairBytes]
  ]);
  const sourceArchiveOrigin = [...extracted.files].find(([path]) => /_origin\.pdf$/i.test(path));
  if (!sourceArchiveOrigin) throw new Error("MinerU origin PDF is missing.");

  const provenance = {
    schema_version: 1,
    title: "A GPU-Accelerated Open-Source Python Package for Calculating Powder Diffraction, Small-Angle-, and Total Scattering with the Debye Scattering Equation",
    authors: [
      "Frederik L. Johansen",
      "Andy S. Anker",
      "Ulrik Friis-Jensen",
      "Erik B. Dam",
      "Kirsten M. Ø. Jensen",
      "Raghavendra Selvan"
    ],
    journal: "Journal of Open Source Software",
    year: 2024,
    doi: "10.21105/joss.06024",
    article_url: "https://joss.theoj.org/papers/10.21105/joss.06024",
    source_pdf_url: "https://joss.theoj.org/papers/10.21105/joss.06024.pdf",
    license: "CC BY 4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    conversion: {
      client: "mineru-open-api 0.5.9",
      date: "2026-08-29",
      model_version: "vlm",
      language: "en",
      is_ocr: false,
      enable_formula: true,
      enable_table: true
    },
    artifacts: {
      uploaded_source_pdf: fileRecord("source.pdf", sourcePdf),
      mineru_raw_archive: fileRecord("mineru-original.mineru.zip", rawArchive),
      mineru_origin_pdf: fileRecord(sourceArchiveOrigin[0], sourceArchiveOrigin[1]),
      article_markdown: fileRecord(extracted.articlePath, articleBytes),
      content_list: fileRecord(extracted.contentListPath, contentListBytes),
      viewer_index: fileRecord("viewer-index.json", viewerBytes),
      visual_repair: fileRecord("visual-repair.json", repairBytes),
      visual_candidates: fileRecord("visual-candidates.json", candidateBytes),
      display_repair: fileRecord("display-repair.json", displayRepairBytes)
    },
    source_pdf_matches_mineru_origin_pdf: sha256(sourcePdf) === sha256(sourceArchiveOrigin[1]),
    derived_display_repair: displayRepair,
    invariants: [
      "The uploaded source PDF and raw MinerU ZIP are byte-preserved.",
      "Markdown, JSON, images, and MinerU's returned origin PDF are unchanged.",
      "After-MinerU adds only hash-bound derived contracts and a Reader projection.",
      "Text recovery is limited to exact raw-text and block matches authorized by the pinned source PDF hash.",
      "Ambiguous or inconsistent repair evidence fails closed."
    ]
  };
  const provenanceBytes = jsonBytes(provenance);
  outputs.set("_source/ATTRIBUTION.md", attributionBytes);
  outputs.set("_source/provenance.json", provenanceBytes);
  const manifest = {
    schema_version: 1,
    extractor: "mineru-open-api",
    created_at: fixedTimestamp,
    processing_depth: "conversion-only",
    source: {
      original_name: "10.21105-joss.06024.pdf",
      size: sourcePdf.byteLength,
      sha256: sha256(sourcePdf)
    },
    privacy: {
      remote_processing: true,
      source_pdf_packaged: true,
      notice: "The selected PDF was sent directly to MinerU for this demonstration. After-MinerU stores no user paper or token."
    },
    options: {
      include_source_pdf: true,
      model_version: "vlm",
      language: "en",
      is_ocr: false,
      enable_formula: true,
      enable_table: true
    },
    outputs: [...outputs].map(([path, data]) => fileRecord(path, data)),
    derived_contracts: [...derived].map(([path, data]) => fileRecord(path, data))
  };
  const validation = {
    status: "passed",
    checks: {
      raw_archive_preserved: true,
      raw_markdown_preserved: true,
      raw_json_preserved: true,
      raw_images_preserved: true,
      uploaded_source_pdf_preserved: true,
      mineru_origin_pdf_preserved: true,
      attribution_preserved: true,
      viewer_index_valid: true,
      visual_repair_valid: true,
      visual_candidates_valid: true,
      source_verified_display_repair_valid: true
    },
    display_repair: summary(displayRepair),
    page_count: pageCount(contentList),
    file_count: extracted.fileCount,
    markdown_count: extracted.markdownCount,
    json_count: extracted.jsonCount,
    image_count: extracted.imageCount,
    viewer_contracts: {
      viewer: summary(viewerIndex),
      repair: summary(visualRepair),
      candidates: summary(visualCandidates)
    }
  };
  const manifestBytes = jsonBytes(manifest);
  const validationBytes = jsonBytes(validation);
  const packageOutputs = new Map(outputs);
  packageOutputs.set("article.md", articleBytes);
  packageOutputs.set("mineru-result.json", contentListBytes);
  const packageManifestBytes = jsonBytes({
    ...manifest,
    outputs: [...packageOutputs].map(([path, data]) => fileRecord(path, data))
  });

  const packageEntries = new Map<string, Uint8Array>([
    ...packageOutputs,
    ...derived,
    ["_extraction/source.pdf", sourcePdf],
    ["_extraction/manifest.json", packageManifestBytes],
    ["_extraction/validation.json", validationBytes],
    ["_extraction/provenance.json", provenanceBytes]
  ]);
  const zippable: Zippable = {};
  for (const [path, data] of [...packageEntries].sort(([left], [right]) => left.localeCompare(right))) {
    zippable[path] = [data, { level: 6, mtime: zipTimestamp }];
  }
  const packageBytes = zipSync(zippable, { level: 6 });
  const generated = new Map<string, Uint8Array>([
    ["viewer-index.json", viewerBytes],
    ["visual-repair.json", repairBytes],
    ["visual-candidates.json", candidateBytes],
    ["display-repair.json", displayRepairBytes],
    ["manifest.json", manifestBytes],
    ["validation.json", validationBytes],
    ["provenance.json", provenanceBytes],
    ["after-mineru.paper2md.zip", packageBytes]
  ]);
  const packageOutputName = process.argv.includes("--package-next")
    ? "after-mineru.paper2md.zip.next"
    : "after-mineru.paper2md.zip";
  const selectedGenerated = process.argv.includes("--package-only") || process.argv.includes("--package-next")
    ? new Map([[packageOutputName, packageBytes]])
    : generated;
  const replaceGenerated = process.argv.includes("--replace-generated");
  for (const filename of selectedGenerated.keys()) {
    const path = resolve(demoRoot, filename);
    if (resolve(demoRoot, basename(path)) !== path) throw new Error(`Unsafe output path: ${filename}`);
    if (!replaceGenerated) {
      await readFile(path).then(
        () => { throw new Error(`Refusing to overwrite ${filename}`); },
        (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }
      );
    }
  }
  await Promise.all([...selectedGenerated].map(([filename, data]) =>
    writeFile(resolve(demoRoot, filename), data, { flag: replaceGenerated ? "w" : "wx" })
  ));
  console.log(JSON.stringify({
    sourcePdf: fileRecord("source.pdf", sourcePdf),
    rawArchive: fileRecord("mineru-original.mineru.zip", rawArchive),
    mineruOriginPdf: fileRecord(sourceArchiveOrigin[0], sourceArchiveOrigin[1]),
    generated: [...selectedGenerated].map(([path, data]) => fileRecord(path, data)),
    contracts: validation.viewer_contracts
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
