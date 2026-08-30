import type { BrowserDirectoryReaderFileSystem } from "../../src/filesystem/browser-directory-reader-file-system";
import type { AfterMinerUManifest } from "../../packages/after-mineru-contract/src/index";

export interface StaticDemoAsset {
  path: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface StaticDemoPackageAsset extends StaticDemoAsset {
  downloadName: string;
  fileCount: number;
  contractVersion: "after-mineru-package-v1" | "paper2md-v0.1.3";
}

const root = "/demo/debyecalculator";

export const DEBYE_CALCULATOR_DEMO = Object.freeze({
  title: "A GPU-Accelerated Open-Source Python Package for Calculating Powder Diffraction, Small-Angle-, and Total Scattering with the Debye Scattering Equation",
  shortTitle: "DebyeCalculator: GPU-accelerated scattering calculations",
  authors: "Frederik L. Johansen, Andy S. Anker, Ulrik Friis-Jensen, Erik B. Dam, Kirsten M. Ø. Jensen, Raghavendra Selvan",
  citation: "Journal of Open Source Software 9(94), 6024 (2024)",
  doiUrl: "https://doi.org/10.21105/joss.06024",
  articleUrl: "https://joss.theoj.org/papers/10.21105/joss.06024",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourcePdf: {
    path: `${root}/source.pdf`,
    size: 1_878_315,
    sha256: "88da42c642b5d651140110d1379ab7d2401bfc2443e9179b39077109e2f42e7f",
    mimeType: "application/pdf"
  },
  sourcePreview: {
    path: `${root}/source-page-1.png`,
    size: 345_759,
    sha256: "d736a9798223b0603c61237cd9a5290a3be82ce5e09a69860c9b07d11e604656",
    mimeType: "image/png"
  },
  rawArchive: {
    path: `${root}/mineru-original.mineru.zip`,
    size: 1_919_117,
    sha256: "1658f548c16e91a6048a8a8ef0706248ec258b15c6dc2ccb28070df2e0e34461",
    mimeType: "application/zip"
  },
  verifiedPackage: {
    path: `${root}/after-mineru-package-v1-53c348ac86dfcd4af36f1abac73d8223389c583ffdae325cdb70205923965cbb.zip`,
    size: 10_991_886,
    sha256: "53c348ac86dfcd4af36f1abac73d8223389c583ffdae325cdb70205923965cbb",
    mimeType: "application/zip",
    downloadName: "debyecalculator.after-mineru.zip",
    fileCount: 52,
    contractVersion: "after-mineru-package-v1"
  } satisfies StaticDemoPackageAsset,
  legacyPackage: {
    path: `${root}/after-mineru.paper2md.zip`,
    size: 5_502_007,
    sha256: "7986728c9d9663ece480139eb13028b4b12e833c2b88010d8908ccb613065f2f",
    mimeType: "application/zip",
    downloadName: "debyecalculator.paper2md-v0.1.3.zip",
    fileCount: 31,
    contractVersion: "paper2md-v0.1.3"
  } satisfies StaticDemoPackageAsset,
  sidecars: Object.freeze({
    viewerIndex: {
      path: `${root}/viewer-index.json`,
      size: 161_659,
      sha256: "90e479d168dc381f4a2c53c2daabed89791c1e9509cd94ed3c5fc047b43645d4",
      mimeType: "application/json"
    },
    visualRepair: {
      path: `${root}/visual-repair.json`,
      size: 2_568,
      sha256: "0c4505f32333cd7843b194a1ae8fca731883115e2bdd05110cf8aea5b8fff28c",
      mimeType: "application/json"
    },
    visualCandidates: {
      path: `${root}/visual-candidates.json`,
      size: 790,
      sha256: "852fb77890192454563d920b6060d547c30ee746c3e2e0bc19205d4486842697",
      mimeType: "application/json"
    },
    displayRepair: {
      path: `${root}/display-repair.json`,
      size: 4_100,
      sha256: "474ce7a9b8d24553b55f9f57a4455be2bd1425fbf4d2943d9f2702516b7dbb21",
      mimeType: "application/json"
    },
    manifest: {
      path: `${root}/manifest.json`,
      size: 4_401,
      sha256: "437b256101cbe2e5db7940e74bdeb434d9d6c58fcc6bbe44998c8d47ecb75782",
      mimeType: "application/json"
    },
    validation: {
      path: `${root}/validation.json`,
      size: 1_254,
      sha256: "f55ed08737a1f8e03553b39b7f37385edee3bc14731e8cf5b78e7920624176d6",
      mimeType: "application/json"
    },
    provenance: {
      path: `${root}/provenance.json`,
      size: 7_270,
      sha256: "b00410acc69553993d85e1f81b16a783156ab38d78349f859c995117ed86ec78",
      mimeType: "application/json"
    },
    attribution: {
      path: `${root}/ATTRIBUTION.md`,
      size: 1_470,
      sha256: "c35a04b50010d1684cde670afc6f7dd2065d0a748b0c3d905414b3f7c0710c10",
      mimeType: "text/markdown"
    }
  })
});

export interface LoadedStaticMinerUDemo {
  createRawPreviewFileSystem(): BrowserDirectoryReaderFileSystem;
  createReaderFileSystem(): BrowserDirectoryReaderFileSystem;
  rawArchive: File;
  rawMarkdown: string;
  rawFocusAssetPaths: string[];
  articlePath: string;
  contentListPath: string;
  diagnostics: string[];
  stats: {
    pages: number;
    files: number;
    json: number;
    images: number;
    repairedGroups: number;
    groupedFragments: number;
    articleRepairs: number;
    captionRepairs: number;
    replacementCharactersRecovered: number;
  };
}

function exactUrl(path: string): URL {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== path || url.search || url.hash) {
    throw new Error("内置示例资源路径无效；已安全停止。");
  }
  return url;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const value = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchPinnedAsset(asset: StaticDemoAsset, signal: AbortSignal): Promise<Uint8Array> {
  const url = exactUrl(asset.path);
  const response = await fetch(url, {
    cache: "no-cache",
    credentials: "same-origin",
    redirect: "error",
    signal
  });
  if (!response.ok || response.redirected) throw new Error(`内置示例资源不可用：${asset.path}`);
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== url.origin || responseUrl.pathname !== url.pathname) {
    throw new Error(`内置示例资源发生了未授权跳转：${asset.path}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.size || await digest(bytes) !== asset.sha256) {
    throw new Error(`内置示例资源未通过大小与 SHA-256 校验：${asset.path}`);
  }
  return bytes;
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function requireFile(files: ReadonlyMap<string, File>, path: string): File {
  const file = files.get(path);
  if (!file) throw new Error(`内置示例缺少契约绑定文件：${path}`);
  return file;
}

async function assertPinnedFile(file: File, asset: StaticDemoAsset): Promise<Uint8Array> {
  const bytes = await fileBytes(file);
  if (bytes.byteLength !== asset.size || await digest(bytes) !== asset.sha256) {
    throw new Error(`内置示例包中的文件未通过大小与 SHA-256 校验：${asset.path}`);
  }
  return bytes;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function markdownImagePath(token: string): string | undefined {
  const match = /^!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)$/s.exec(token);
  const source = match?.[1] || match?.[2] || "";
  if (!source) return undefined;
  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    return undefined;
  }
  const path = decoded.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/, 1)[0];
  return path && !path.startsWith("/") && !path.includes("..") ? path : undefined;
}

function rawFragmentFocusPaths(viewerValue: unknown, repairValue: unknown, markdown: string): string[] {
  const viewer = record(viewerValue);
  const repair = record(repairValue);
  const groups = Array.isArray(repair?.groups)
    ? repair.groups.map(record).filter((group): group is UnknownRecord => Boolean(
      group
      && group.decision === "auto"
      && record(group.replacement)?.mode === "pdf_crop"
      && Array.isArray(group.member_markdown_image_ids)
      && group.member_markdown_image_ids.length === 4
    ))
    : [];
  const markdownImages = Array.isArray(viewer?.markdown_images) ? viewer.markdown_images : [];
  if (groups.length !== 1 || !markdownImages.length) {
    throw new Error("内置示例没有唯一的四图碎片定位契约；已安全停止。");
  }
  const ids = groups[0].member_markdown_image_ids as unknown[];
  if (!ids.every((id): id is string => typeof id === "string") || new Set(ids).size !== ids.length) {
    throw new Error("内置示例的碎图定位标识无效；已安全停止。");
  }
  return ids.map((id) => {
    const matches = markdownImages.map(record).filter((image): image is UnknownRecord => image?.id === id);
    if (matches.length !== 1) throw new Error("内置示例的碎图定位不唯一；已安全停止。");
    const start = Number(matches[0].char_start);
    const end = Number(matches[0].char_end);
    const assetPath = typeof matches[0].asset_path === "string" ? matches[0].asset_path : "";
    const token = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= markdown.length
      ? markdown.slice(start, end)
      : "";
    if (!assetPath || markdownImagePath(token) !== assetPath) {
      throw new Error("内置示例的碎图位置与原始 Markdown 不匹配；已安全停止。");
    }
    return assetPath;
  });
}

export async function loadStaticMinerUDemo(signal: AbortSignal): Promise<LoadedStaticMinerUDemo> {
  const sidecars = DEBYE_CALCULATOR_DEMO.sidecars;
  const [formalArchiveBytes, publicRawArchiveBytes, publicSourcePdfBytes, publicAttributionBytes, imports] = await Promise.all([
    fetchPinnedAsset(DEBYE_CALCULATOR_DEMO.verifiedPackage, signal),
    fetchPinnedAsset(DEBYE_CALCULATOR_DEMO.rawArchive, signal),
    fetchPinnedAsset(DEBYE_CALCULATOR_DEMO.sourcePdf, signal),
    fetchPinnedAsset(sidecars.attribution, signal),
    Promise.all([
      import("../../apps/web/src/after-mineru-archive-import"),
      import("../../apps/web/src/mineru-archive-import"),
      import("../../src/filesystem/browser-directory-reader-file-system"),
      import("../../src/model/package-loader")
    ])
  ]);
  if (signal.aborted) throw new DOMException("Demo loading was aborted", "AbortError");
  const [
    { extractAfterMinerUArchiveBytes },
    { importMinerUArchiveFile },
    { BrowserDirectoryReaderFileSystem },
    { PackageLoader }
  ] = imports;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const packageFiles = await extractAfterMinerUArchiveBytes(formalArchiveBytes);
  if (packageFiles.size !== DEBYE_CALCULATOR_DEMO.verifiedPackage.fileCount) {
    throw new Error("内置示例包的文件数量与固定清单不一致；已安全停止。");
  }
  const manifest = JSON.parse(await requireFile(packageFiles, "after-mineru.manifest.json").text()) as AfterMinerUManifest;
  if (manifest.schema_version !== DEBYE_CALCULATOR_DEMO.verifiedPackage.contractVersion) {
    throw new Error("内置示例包的版本与固定契约不一致；已安全停止。");
  }
  const rawArchive = requireFile(packageFiles, manifest.source.archive_path);
  const sourcePdf = requireFile(packageFiles, manifest.source.pdf_path ?? "");
  const attribution = requireFile(packageFiles, "sidecars/ATTRIBUTION.md");
  const attributionAlias = requireFile(packageFiles, "_source/ATTRIBUTION.md");
  const [rawArchiveBytes, sourcePdfBytes, attributionBytes, attributionAliasBytes] = await Promise.all([
    assertPinnedFile(rawArchive, DEBYE_CALCULATOR_DEMO.rawArchive),
    assertPinnedFile(sourcePdf, DEBYE_CALCULATOR_DEMO.sourcePdf),
    assertPinnedFile(attribution, sidecars.attribution),
    fileBytes(attributionAlias)
  ]);
  if (
    !sameBytes(rawArchiveBytes, publicRawArchiveBytes)
    || !sameBytes(sourcePdfBytes, publicSourcePdfBytes)
    || !sameBytes(attributionBytes, publicAttributionBytes)
    || !sameBytes(attributionBytes, attributionAliasBytes)
  ) throw new Error("内置示例包与公开源文件或署名副本不一致；已安全停止。");

  const viewerFile = requireFile(packageFiles, manifest.sidecars.viewer_index_path);
  const repairFile = requireFile(packageFiles, manifest.sidecars.visual_repair_path);
  const displayRepairPath = manifest.sidecars.display_repair_path;
  if (!displayRepairPath) throw new Error("内置示例包没有声明文字修复 sidecar；已安全停止。");
  const displayRepairFile = requireFile(packageFiles, displayRepairPath);
  const formalValidationFile = requireFile(packageFiles, manifest.sidecars.validation_path);
  const [viewerBytes, repairBytes, displayRepairBytes, validationBytes] = await Promise.all([
    assertPinnedFile(viewerFile, sidecars.viewerIndex),
    assertPinnedFile(repairFile, sidecars.visualRepair),
    assertPinnedFile(displayRepairFile, sidecars.displayRepair),
    fileBytes(formalValidationFile)
  ]);
  const validation = JSON.parse(decoder.decode(validationBytes)) as { summary?: UnknownRecord };
  const displayRepair = JSON.parse(decoder.decode(displayRepairBytes)) as UnknownRecord;
  const displaySummary = record(displayRepair.summary);
  const articleRepairs = Number(displaySummary?.article_repair_count ?? 0);
  const captionRepairs = Number(displaySummary?.caption_repair_count ?? 0);
  const replacementCharactersRecovered = Number(displaySummary?.replacement_characters_before ?? 0);
  const validationSummary = record(validation.summary);
  if (
    displayRepair.algorithm_version !== "source-pdf-exact-display-repair-v1"
    || record(record(displayRepair.inputs)?.source_pdf)?.sha256 !== DEBYE_CALCULATOR_DEMO.sourcePdf.sha256
    || displaySummary?.replacement_characters_after !== 0
    || displaySummary?.repair_count !== 4
    || articleRepairs !== 2
    || captionRepairs !== 2
    || replacementCharactersRecovered !== 33
    || validationSummary?.repaired_visual_count !== 1
    || validationSummary?.review_candidate_count !== 0
    || validationSummary?.unresolved_text_replacement_count !== 0
  ) {
    throw new Error("内置示例的派生文字修复记录无效；已安全停止。");
  }
  const imported = await importMinerUArchiveFile(rawArchive, signal);
  if (signal.aborted) throw new DOMException("Demo loading was aborted", "AbortError");
  const rawFiles = new Map(imported.files);
  const formalFiles = new Map(packageFiles);
  const rawSource = Object.freeze({
      format: "mineru-zip",
      sourceArchive: imported.sourceArchive,
      sourceRootPrefix: imported.rootPrefix,
      articlePath: imported.articlePath,
      contentListPath: imported.contentListPath,
      fileCount: imported.fileCount,
      markdownCount: imported.markdownCount,
      jsonCount: imported.jsonCount,
      imageCount: imported.imageCount
  } as const);
  const createRawPreviewFileSystem = (): BrowserDirectoryReaderFileSystem => (
    BrowserDirectoryReaderFileSystem.fromMinerUArchive(
      "DebyeCalculator · MinerU 原始结果",
      new Map(rawFiles),
      rawSource
    )
  );
  const createReaderFileSystem = (): BrowserDirectoryReaderFileSystem => (
    BrowserDirectoryReaderFileSystem.fromAfterMinerUArchive(
      "DebyeCalculator · After-MinerU v1",
      new Map(formalFiles)
    )
  );
  const fileSystem = createReaderFileSystem();
  let contentFileSystem: { dispose(): void } | undefined;
  try {
    const loaded = await new PackageLoader(fileSystem, {
      legacyMinerUProjectionMode: "source-only",
      allowRuntimeTextRecovery: false
    }).loadDetected();
    contentFileSystem = loaded.contentFileSystem;
    const repaired = loaded.assets.find((asset) => asset.memberAssetPaths?.length === 4);
    if (
      loaded.packageIntegrity !== "verified"
      || loaded.contractVersion !== "after-mineru-package-v1"
      || loaded.activeProjection?.kind !== "verified-derived"
      || !loaded.articlePath.endsWith("derived/article.after-mineru.md")
      || loaded.sourcePdf?.path !== "_extraction/source.pdf"
      || loaded.visualReview !== undefined
      || loaded.textRecovery !== undefined
      || !repaired
      || !loaded.diagnostics.some((item) => item.code === "after-mineru-derived-projection-verified")
      || loaded.diagnostics.some((item) => item.code.startsWith("mineru-"))
    ) {
      throw new Error("内置示例未通过 formal v1 只读 Reader 验收；已安全停止。");
    }
    const article = imported.files.get(imported.articlePath);
    if (!article) throw new Error("MinerU 原始 Markdown 不存在；已安全停止。");
    const rawMarkdown = await article.text();
    const rawFocusAssetPaths = rawFragmentFocusPaths(
      JSON.parse(decoder.decode(viewerBytes)) as unknown,
      JSON.parse(decoder.decode(repairBytes)) as unknown,
      rawMarkdown
    );
    if (
      [...rawMarkdown].filter((character) => character === "�").length !== 33
      || loaded.articleText.includes("�")
      || loaded.assets.some((asset) => asset.captionText?.includes("�"))
    ) throw new Error("内置示例的原始/派生文字边界未通过验收；已安全停止。");
    return {
      createRawPreviewFileSystem,
      createReaderFileSystem,
      rawArchive,
      rawMarkdown,
      rawFocusAssetPaths,
      articlePath: imported.articlePath,
      contentListPath: imported.contentListPath,
      diagnostics: loaded.diagnostics.map((item) => item.message),
      stats: {
        pages: loaded.pdfLayout?.pageCount ?? 6,
        files: imported.fileCount,
        json: imported.jsonCount,
        images: imported.imageCount,
        repairedGroups: 1,
        groupedFragments: repaired.memberAssetPaths?.length ?? 0,
        articleRepairs,
        captionRepairs,
        replacementCharactersRecovered
      }
    };
  } catch (error) {
    throw error;
  } finally {
    if (contentFileSystem && contentFileSystem !== fileSystem) contentFileSystem.dispose();
    fileSystem.dispose();
  }
}
