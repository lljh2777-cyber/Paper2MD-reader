import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { ManifestBoundReaderFileSystem } from "../filesystem/manifest-bound-reader-file-system";
import {
  derivePackageState,
  isSafeRelativePath,
  normalizeContract,
  parseAnchorInventory,
  supportsContractVersion
} from "./contract-validation";
import { validateManifestBinding } from "./manifest-validation";
import { mapWithConcurrency, PACKAGE_LIMITS, PackageLimitError } from "./package-limits";
import {
  Diagnostic,
  LoadedAsset,
  LoadedPaperPackage,
  RawReaderContract
} from "./reader-contract";
import { adaptClippingMarkdown, ClippingVisual } from "./clipping-markdown";
import { convertClippingHtmlToMarkdown } from "./clipping-html";
import { injectMinerUVisualAnchors, parseMinerUContentList } from "./mineru-content-list";
import {
  collectPdfCaptionContinuationRequests,
  PdfCaptionContinuationRequest
} from "./mineru-caption-recovery";
import {
  collectMinerUParagraphRecoveryRequests,
  collectMinerUTextRecoveryCandidates,
  MinerUParagraphRecoveryRequest
} from "./mineru-text-recovery";
import { buildMinerUPageMap } from "./mineru-page-map";
import { buildMinerUPdfLayout } from "./mineru-pdf-layout";
import {
  inspectMinerUPackageIntegrity,
  readVerifiedMinerUDerivedJson
} from "./mineru-package-integrity";
import {
  applyMinerUDisplayArticleRepairs,
  applyMinerUDisplayCaptionRepairs,
  MinerUDisplayRepairPlan,
  prepareMinerUDisplayRepair
} from "./mineru-display-repair";
import { applyMinerUVisualRepair, RepairedMinerUVisual } from "./mineru-visual-repair";
import { projectMinerUReaderMarkdown } from "./mineru-reader-projection";
import { prepareMinerUVisualReview } from "./mineru-visual-review";
import { contentListForMarkdown, detectPackageSource } from "./package-source";
import { inspectMarkdownResources } from "../render/markdown-resource-policy";
import {
  AFTER_MINERU_MANIFEST_PATH,
  AFTER_MINERU_PACKAGE_VERSION,
  AfterMinerUPackageValidationError,
  type AfterMinerUVisualDisplay,
  validateAfterMinerUPackage
} from "../../packages/after-mineru-contract/src/index";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

export interface PackageLoaderOptions {
  /**
   * Allow the legacy Reader to derive display-only text recovery from a
   * bundled PDF at load time. Read-only Reader entry points disable this so
   * raw MinerU content is never repaired by the consumer.
   */
  allowRuntimeTextRecovery?: boolean;
}

async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class PackageLoader {
  constructor(
    private readonly fileSystem: ReaderFileSystem,
    private readonly options: PackageLoaderOptions = {}
  ) {}

  async loadDetected(visualReviewSidecar?: unknown): Promise<LoadedPaperPackage> {
    if (await this.fileSystem.exists(AFTER_MINERU_MANIFEST_PATH)) return this.loadAfterMinerU();
    const source = await detectPackageSource(this.fileSystem);
    if (source.format === "mineru") return this.loadMinerU(source.articlePath, source.contentListPath, visualReviewSidecar);
    if (source.format === "html") return this.loadHtml(source.articlePath);
    const loaded = await this.load(source.articlePath, visualReviewSidecar);
    loaded.sourceFormat = source.format;
    return loaded;
  }

  private async loadAfterMinerU(): Promise<LoadedPaperPackage> {
    const verified = await validateAfterMinerUPackage(this.fileSystem);
    const manifest = verified.manifest;
    const projection = verified.readerProjection;
    const derivedRecord = manifest.derived.files.find((entry) => entry.path === manifest.derived.article_path)!;
    const sourceRecord = manifest.source.files.find((entry) => entry.path === manifest.source.article_path)!;
    const contentFileSystem = new ManifestBoundReaderFileSystem(this.fileSystem, [
      ...verified.records.values(),
      ...manifest.compatibility.aliases
    ]);
    try {
      const articleText = await contentFileSystem.readText(manifest.derived.article_path);
      const resources = inspectMarkdownResources(articleText);
      const unboundResource = resources.localPaths.find((path) => !contentFileSystem.isBoundPath(path));
      if (resources.blockedUrls.length || unboundResource) {
        throw new AfterMinerUPackageValidationError(
          `After-MinerU derived Markdown references an unbound resource: ${resources.blockedUrls[0] ?? unboundResource}`
        );
      }
      const anchors = parseAnchorInventory(articleText);
      const claimedPlacements = new Set<string>();
      for (const visual of projection.visuals) {
        const placement = visual.placement_block_id;
        if (placement === null) continue;
        if (
          claimedPlacements.has(placement)
          || anchors.duplicateIds.includes(placement)
          || anchors.slotAssets.get(placement) !== visual.id
        ) {
          throw new AfterMinerUPackageValidationError(
            `After-MinerU visual placement is not bound to the derived Markdown slot: ${visual.id}`
          );
        }
        claimedPlacements.add(placement);
      }
      const sourcePdfAlias = manifest.source.pdf_path
        ? manifest.compatibility.aliases.find((entry) => (
          entry.canonical_path === manifest.source.pdf_path && entry.path === "_extraction/source.pdf"
        ))
        : undefined;
      const display = (value: AfterMinerUVisualDisplay): LoadedAsset["display"] => {
        if (value.mode === "pdf-crop") {
          return { mode: "pdf-crop", pdfPath: value.pdf_path, bbox: { ...value.bbox }, padding: value.padding };
        }
        if (value.mode === "fragment-set") {
          return {
            mode: "fragment-set",
            fragments: value.fragments.map((fragment) => ({ path: fragment.path, bbox: { ...fragment.bbox } }))
          };
        }
        return { mode: "asset" };
      };
      const assets: LoadedAsset[] = projection.visuals.map((visual) => ({
        id: visual.id,
        kind: visual.kind,
        path: visual.path,
        display_label: visual.label,
        caption_block_id: null,
        placement_block_id: visual.placement_block_id,
        vaultPath: contentFileSystem.resolvePath(visual.path),
        exists: true,
        integrityMatches: true,
        captionText: visual.caption_text ?? undefined,
        pageIndex: visual.page_index ?? undefined,
        sourceBBox: visual.source_bbox ?? undefined,
        memberAssetPaths: [...visual.member_asset_paths],
        memberBlockIds: [...visual.member_block_ids],
        captionPageIndex: visual.caption_page_index ?? undefined,
        captionStatus: visual.caption_status ?? undefined,
        display: display(visual.display)
      }));
      return {
        state: "mineru",
        sourceFormat: "mineru",
        packageIntegrity: "verified",
        contentFileSystem,
        articlePath: contentFileSystem.resolvePath(manifest.derived.article_path),
        articleText,
        articleHash: derivedRecord.sha256,
        contractPath: contentFileSystem.resolvePath(manifest.sidecars.reader_projection_path),
        contractVersion: AFTER_MINERU_PACKAGE_VERSION,
        manifestPath: this.fileSystem.resolvePath(AFTER_MINERU_MANIFEST_PATH),
        anchors,
        assets,
        diagnostics: [{
          level: "info",
          code: "after-mineru-derived-projection-verified",
          message: `已完整验证并只读呈现 After-MinerU 派生 Markdown 与 ${assets.length} 个视觉对象；Reader 未生成或写回修复。`
        }],
        sourceArticle: {
          path: contentFileSystem.resolvePath(manifest.source.article_path),
          sha256: sourceRecord.sha256
        },
        activeProjection: {
          kind: "verified-derived",
          manifestVersion: manifest.schema_version,
          path: contentFileSystem.resolvePath(manifest.derived.article_path),
          sha256: derivedRecord.sha256
        },
        sourcePdf: manifest.source.pdf_path
          ? { path: sourcePdfAlias?.path ?? manifest.source.pdf_path }
          : undefined
      };
    } catch (error) {
      contentFileSystem.dispose();
      throw error;
    }
  }

  private async loadHtml(articleRelativePath: string): Promise<LoadedPaperPackage> {
    if (!isSafeRelativePath(articleRelativePath)) throw new Error(`Unsafe HTML article path: ${articleRelativePath}`);
    const source = await this.readTextWithinLimit(
      articleRelativePath,
      PACKAGE_LIMITS.clippingHtmlBytes,
      "Web clipping HTML"
    );
    const initial = convertClippingHtmlToMarkdown(source.text, { sourcePath: articleRelativePath });
    const imageInfos = await mapWithConcurrency(
      initial.localImagePaths,
      PACKAGE_LIMITS.assetHashConcurrency,
      (path) => this.fileSystem.fileInfo(path)
    );
    const availableImagePaths = new Set(initial.localImagePaths.filter((_, index) => Boolean(imageInfos[index])));
    const converted = convertClippingHtmlToMarkdown(source.text, {
      sourcePath: articleRelativePath,
      availableImagePaths
    });
    const markdownBytes = new TextEncoder().encode(converted.markdown);
    if (!converted.markdown.trim()) throw new Error("Web clipping HTML does not contain readable article content.");
    if (markdownBytes.byteLength > PACKAGE_LIMITS.articleBytes) {
      throw new PackageLimitError(
        `Converted web clipping is ${markdownBytes.byteLength} bytes; the safe limit is ${PACKAGE_LIMITS.articleBytes}.`,
        markdownBytes.byteLength,
        PACKAGE_LIMITS.articleBytes
      );
    }
    const adapted = adaptClippingMarkdown(converted.markdown);
    const diagnostics: Diagnostic[] = [{
      level: "info",
      code: "html-display-conversion",
      message: `网页 HTML 已转换为只读显示投影，并配对 ${adapted.visuals.length} 个本地图片与紧邻图注；原始 HTML 未修改。`
    }];
    const unavailableCount = initial.localImagePaths.length - availableImagePaths.size;
    const blockedCount = new Set(initial.blockedImageSources).size;
    if (unavailableCount || blockedCount) {
      diagnostics.push({
        level: "warning",
        code: "html-resource-omitted",
        message: `${unavailableCount + blockedCount} 个远程、不安全或缺失的网页图片未进入阅读显示；请随 HTML 一并导入本地图片资源。`
      });
    }
    const assets = await this.loadClippingAssets(adapted.visuals, diagnostics);
    return {
      state: adapted.visuals.length ? "markdown" : "reader-missing",
      sourceFormat: "html",
      articlePath: this.fileSystem.resolvePath(articleRelativePath),
      articleText: adapted.articleText,
      articleHash: await sha256(source.bytes),
      anchors: parseAnchorInventory(adapted.articleText),
      assets,
      diagnostics
    };
  }

  private async readTextWithinLimit(relativePath: string, limit: number, label: string): Promise<{ text: string; bytes: Uint8Array }> {
    const info = await this.fileSystem.fileInfo(relativePath);
    if (info && info.size > limit) {
      throw new PackageLimitError(`${label} is ${info.size} bytes; the safe limit is ${limit}.`, info.size, limit);
    }
    const text = await this.fileSystem.readText(relativePath);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > limit) {
      throw new PackageLimitError(`${label} is ${bytes.byteLength} bytes; the safe limit is ${limit}.`, bytes.byteLength, limit);
    }
    return { text, bytes };
  }

  async load(articleRelativePath = "article.md", visualReviewSidecar?: unknown): Promise<LoadedPaperPackage> {
    if (await this.fileSystem.exists(AFTER_MINERU_MANIFEST_PATH)) return this.loadAfterMinerU();
    if (!isSafeRelativePath(articleRelativePath)) throw new Error(`Unsafe article path: ${articleRelativePath}`);
    if (articleRelativePath !== "article.md") {
      const stem = articleRelativePath.replace(/\.md$/i, "");
      const stableContentList = `${stem}_content_list.json`;
      const v2ContentList = `${stem}_content_list_v2.json`;
      if (await this.fileSystem.exists(stableContentList)) return this.loadMinerU(articleRelativePath, stableContentList, visualReviewSidecar);
      if (await this.fileSystem.exists(v2ContentList)) return this.loadMinerU(articleRelativePath, v2ContentList, visualReviewSidecar);
      const detectedContentList = contentListForMarkdown(articleRelativePath, await this.fileSystem.listFiles(""));
      if (detectedContentList) return this.loadMinerU(articleRelativePath, detectedContentList, visualReviewSidecar);
    }
    const article = await this.readTextWithinLimit(articleRelativePath, PACKAGE_LIMITS.articleBytes, "article.md");
    const articleText = article.text;
    const articleHash = await sha256(article.bytes);
    const anchors = parseAnchorInventory(articleText);
    const articlePath = this.fileSystem.resolvePath(articleRelativePath);
    const contractRelativePath = "_paper2md/reader.json";
    const contractPath = this.fileSystem.resolvePath(contractRelativePath);
    const diagnostics: Diagnostic[] = [];

    if (!await this.fileSystem.exists(contractRelativePath)) {
      const sourcePdfPath = "_extraction/source.pdf";
      const hasSourcePdf = await this.fileSystem.exists(sourcePdfPath);
      if (hasSourcePdf) {
        const sourceInfo = await this.fileSystem.fileInfo(sourcePdfPath);
        if (sourceInfo && sourceInfo.size > PACKAGE_LIMITS.sourcePdfBytes) {
          throw new PackageLimitError(
            `source.pdf is ${sourceInfo.size} bytes; the safe limit is ${PACKAGE_LIMITS.sourcePdfBytes}.`,
            sourceInfo.size,
            PACKAGE_LIMITS.sourcePdfBytes
          );
        }
      }
      const hasPaper2mdAnchors = anchors.blockIds.length > 0 || anchors.slotIds.length > 0 || anchors.malformedMarkers.length > 0;
      const adapted = hasPaper2mdAnchors
        ? { articleText, visuals: [] }
        : adaptClippingMarkdown(articleText);
      const pairedAssets = await this.loadClippingAssets(adapted.visuals, diagnostics);
      diagnostics.push(adapted.visuals.length ? {
        level: "info",
        code: "markdown-display-pairing",
        message: `已在阅读显示层配对 ${adapted.visuals.length} 个图片与紧邻图注；Figure 编号未写回原始 Markdown。`
      } : {
        level: "info",
        code: "reader-missing",
        message: "未找到 _paper2md/reader.json，已使用普通 Markdown 与图片目录降级。"
      });
      return {
        state: adapted.visuals.length ? "markdown" : "reader-missing",
        sourceFormat: "markdown",
        articlePath,
        articleText: adapted.articleText,
        articleHash,
        anchors: parseAnchorInventory(adapted.articleText),
        assets: pairedAssets.length ? pairedAssets : await this.loadFallbackAssets(),
        sourcePdf: hasSourcePdf ? { path: sourcePdfPath } : undefined,
        diagnostics
      };
    }

    let readerText: string;
    let raw: RawReaderContract;
    try {
      readerText = (await this.readTextWithinLimit(contractRelativePath, PACKAGE_LIMITS.contractBytes, "reader.json")).text;
      raw = JSON.parse(readerText) as unknown;
    } catch (error) {
      if (error instanceof PackageLimitError) throw error;
      diagnostics.push({ level: "error", code: "invalid-json", message: "reader.json 不是有效 JSON，已降级为普通 Markdown。" });
      return {
        state: "invalid-contract",
        articlePath,
        articleText,
        articleHash,
        contractPath,
        anchors,
        assets: [],
        diagnostics
      };
    }

    const normalized = normalizeContract(raw);
    diagnostics.push(...normalized.diagnostics);
    if (!normalized.contract) {
      if (normalized.contractVersion && !supportsContractVersion(normalized.contractVersion)) {
        diagnostics.push({
          level: "warning",
          code: "unsupported-version",
          message: `不支持契约版本 ${normalized.contractVersion}，已降级为普通 Markdown。`
        });
        return {
          state: "unsupported-version",
          articlePath,
          articleText,
          articleHash,
          contractPath,
          contractVersion: normalized.contractVersion,
          anchors,
          assets: [],
          diagnostics
        };
      }
      return {
        state: "invalid-contract",
        articlePath,
        articleText,
        articleHash,
        contractPath,
        contractVersion: normalized.contractVersion,
        anchors,
        assets: [],
        diagnostics
      };
    }

    const contract = normalized.contract;
    if (contract.article.path !== articleRelativePath) {
      diagnostics.push({
        level: "error",
        code: "article-path-mismatch",
        message: `契约指向 ${contract.article.path}，不是当前文件 ${articleRelativePath}。`
      });
    }

    const manifestRelativePath = "_paper2md/manifest.json";
    const manifestPath = this.fileSystem.resolvePath(manifestRelativePath);
    const manifestExists = await this.fileSystem.exists(manifestRelativePath);
    if (manifestExists) {
      try {
        const manifestText = await this.readTextWithinLimit(manifestRelativePath, PACKAGE_LIMITS.manifestBytes, "manifest.json");
        const rawManifest = JSON.parse(manifestText.text) as unknown;
        diagnostics.push(...validateManifestBinding(rawManifest, contract, await sha256(readerText)));
      } catch (error) {
        if (error instanceof PackageLimitError) throw error;
        diagnostics.push({ level: "error", code: "invalid-manifest-json", message: "manifest.json 不是有效 JSON。" });
      }
    } else {
      diagnostics.push({
        level: "warning",
        code: "manifest-missing",
        message: "未找到 _paper2md/manifest.json；继续使用 reader.json 自身的完整性信息。"
      });
    }

    const assetInfos = await mapWithConcurrency(
      contract.assets,
      PACKAGE_LIMITS.assetHashConcurrency,
      (asset) => this.fileSystem.fileInfo(asset.path)
    );
    let actualAssetBytes = 0;
    assetInfos.forEach((info, index) => {
      if (!info) return;
      if (info.size > PACKAGE_LIMITS.assetBytes) {
        throw new PackageLimitError(
          `Paper asset ${contract.assets[index].path} is ${info.size} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
          info.size,
          PACKAGE_LIMITS.assetBytes
        );
      }
      actualAssetBytes += info.size;
      if (actualAssetBytes > PACKAGE_LIMITS.totalAssetBytes) {
        throw new PackageLimitError(
          `Paper assets total ${actualAssetBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`,
          actualAssetBytes,
          PACKAGE_LIMITS.totalAssetBytes
        );
      }
    });

    const assets = await mapWithConcurrency(contract.assets, PACKAGE_LIMITS.assetHashConcurrency, async (asset, index): Promise<LoadedAsset> => {
      const vaultPath = this.fileSystem.resolvePath(asset.path);
      const info = assetInfos[index];
      const exists = Boolean(info);
      let integrityMatches: boolean | undefined;
      if (!exists) {
        diagnostics.push({ level: "error", code: "missing-asset", message: `资源不存在：${asset.path}` });
      } else {
        const sizeMatches = info!.size === asset.size_bytes;
        if (!sizeMatches) {
          diagnostics.push({ level: "error", code: "asset-size-mismatch", message: `资源大小不匹配：${asset.path}` });
        }
        if (!sizeMatches) {
          integrityMatches = false;
        } else {
          const actualHash = await sha256(await this.fileSystem.readBinary(asset.path));
          const hashMatches = actualHash.toLowerCase() === asset.sha256.toLowerCase();
          if (!hashMatches) {
            diagnostics.push({ level: "error", code: "asset-hash-mismatch", message: `资源哈希不匹配：${asset.path}` });
          }
          integrityMatches = hashMatches;
        }
      }
      return { ...asset, vaultPath, exists, integrityMatches };
    });

    const state = derivePackageState(contract, diagnostics, articleHash, anchors);
    return {
      state,
      articlePath,
      articleText,
      articleHash,
      contractPath,
      contractVersion: contract.contract_version,
      manifestPath: manifestExists ? manifestPath : undefined,
      contract,
      anchors,
      assets,
      diagnostics
    };
  }

  private async loadMinerU(articleRelativePath: string, contentListRelativePath: string, visualReviewSidecar?: unknown): Promise<LoadedPaperPackage> {
    if (!isSafeRelativePath(articleRelativePath) || !isSafeRelativePath(contentListRelativePath)) {
      throw new Error("Unsafe MinerU package path");
    }
    const article = await this.readTextWithinLimit(articleRelativePath, PACKAGE_LIMITS.articleBytes, "MinerU Markdown");
    const contentList = await this.readTextWithinLimit(
      contentListRelativePath,
      PACKAGE_LIMITS.mineruContentListBytes,
      "MinerU content list"
    );
    const mineruPayload = JSON.parse(contentList.text) as unknown;
    const parsed = parseMinerUContentList(mineruPayload);
    if (parsed.visuals.length > PACKAGE_LIMITS.assetCount) {
      throw new PackageLimitError(
        `MinerU content list contains ${parsed.visuals.length} visual assets; the safe limit is ${PACKAGE_LIMITS.assetCount}.`,
        parsed.visuals.length,
        PACKAGE_LIMITS.assetCount
      );
    }

    const articleHash = await sha256(article.bytes);
    const mineruHash = await sha256(contentList.bytes);
    let articleText = injectMinerUVisualAnchors(article.text, parsed.visuals);
    const diagnostics: Diagnostic[] = [...parsed.diagnostics, {
      level: "info",
      code: "mineru-structured-source",
      message: `已识别 MinerU content_list ${parsed.version}；图、图注、页码与 bbox 已载入 Reader。`
    }];
    if (parsed.version === "v2") {
      diagnostics.push({
        level: "warning",
        code: "mineru-content-list-v2",
        message: "MinerU content_list_v2.json 仍是开发格式；Reader 已按当前公共字段兼容解析。"
      });
    }

    let visuals: RepairedMinerUVisual[] = parsed.visuals;
    let verificationVisuals: RepairedMinerUVisual[] = visuals;
    let captionContinuations: PdfCaptionContinuationRequest[] = [];
    let paragraphRecoveries: MinerUParagraphRecoveryRequest[] = [];
    let pageMap: LoadedPaperPackage["pageMap"];
    let pdfLayout: LoadedPaperPackage["pdfLayout"];
    let visualReview: LoadedPaperPackage["visualReview"];
    let contractVersion = `mineru-content-list-${parsed.version}`;
    const viewerIndexPath = "_extraction/viewer-index.json";
    const visualRepairPath = "_extraction/visual-repair.json";
    const visualCandidatesPath = "_extraction/visual-candidates.json";
    const displayRepairPath = "_extraction/display-repair.json";
    const sourcePdfPath = "_extraction/source.pdf";
    const [hasViewerIndex, hasVisualRepair, hasSourcePdf] = await Promise.all([
      this.fileSystem.exists(viewerIndexPath),
      this.fileSystem.exists(visualRepairPath),
      this.fileSystem.exists(sourcePdfPath)
    ]);
    const integrity = await inspectMinerUPackageIntegrity({
      fileSystem: this.fileSystem,
      articlePath: articleRelativePath,
      articleBytes: article.bytes,
      mineruPath: contentListRelativePath,
      mineruBytes: contentList.bytes,
      sourcePdfPath
    });
    diagnostics.push(...integrity.diagnostics);
    if (hasSourcePdf) {
      const sourceInfo = await this.fileSystem.fileInfo(sourcePdfPath);
      if (sourceInfo && sourceInfo.size > PACKAGE_LIMITS.sourcePdfBytes) {
        throw new PackageLimitError(
          `source.pdf is ${sourceInfo.size} bytes; the safe limit is ${PACKAGE_LIMITS.sourcePdfBytes}.`,
          sourceInfo.size,
          PACKAGE_LIMITS.sourcePdfBytes
        );
      }
    }
    if (hasViewerIndex && hasVisualRepair && integrity.status === "verified") {
      try {
        const [viewerContract, visualRepairContract] = integrity.status === "verified"
          ? await Promise.all([
            readVerifiedMinerUDerivedJson(this.fileSystem, viewerIndexPath, integrity.derived.get(viewerIndexPath)),
            readVerifiedMinerUDerivedJson(this.fileSystem, visualRepairPath, integrity.derived.get(visualRepairPath))
          ])
          : await Promise.all([
            this.readTextWithinLimit(viewerIndexPath, PACKAGE_LIMITS.viewerContractBytes, "viewer-index.json").then((value) => JSON.parse(value.text) as unknown),
            this.readTextWithinLimit(visualRepairPath, PACKAGE_LIMITS.viewerContractBytes, "visual-repair.json").then((value) => JSON.parse(value.text) as unknown)
          ]);
        let effectiveVisualRepair = visualRepairContract;
        if (integrity.status === "verified" && integrity.derived.has(visualCandidatesPath)) {
          try {
            const candidateRecord = integrity.derived.get(visualCandidatesPath)!;
            const candidatePackage = await readVerifiedMinerUDerivedJson(
              this.fileSystem,
              visualCandidatesPath,
              candidateRecord
            );
            const prepared = await prepareMinerUVisualReview({
              candidatePackage,
              viewerIndex: viewerContract,
              visualRepair: visualRepairContract,
              articleHash,
              mineruHash,
              mineruPayload,
              articleMarkdown: article.text,
              sourcePdfPath: hasSourcePdf ? sourcePdfPath : undefined,
              candidateFileHash: candidateRecord.sha256,
              sidecar: visualReviewSidecar
            });
            effectiveVisualRepair = prepared.visualRepair;
            visualReview = prepared.review;
            diagnostics.push(...prepared.diagnostics);
          } catch (error) {
            diagnostics.push({
              level: "warning",
              code: "mineru-visual-review-invalid",
              message: `视觉候选审阅不可用，已保留确定性修复：${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else if (integrity.status === "verified" && await this.fileSystem.exists(visualCandidatesPath)) {
          diagnostics.push({
            level: "warning",
            code: "mineru-visual-review-unlisted",
            message: "visual-candidates.json 未登记在 manifest.json，已禁止人工视觉修复。"
          });
        }
        let displayRepairPlan: MinerUDisplayRepairPlan | undefined;
        if (integrity.status === "verified" && integrity.derived.has(displayRepairPath)) {
          try {
            const displayRepairContract = await readVerifiedMinerUDerivedJson(
              this.fileSystem,
              displayRepairPath,
              integrity.derived.get(displayRepairPath)
            );
            displayRepairPlan = await prepareMinerUDisplayRepair({
              contract: displayRepairContract,
              viewerIndex: viewerContract,
              mineruPayload,
              sourceArticle: article.text,
              articleHash,
              mineruHash,
              sourcePdfHash: integrity.sourcePdfSha256 ?? ""
            });
          } catch (error) {
            diagnostics.push({
              level: "warning",
              code: "mineru-display-repair-invalid",
              message: `显示修复契约无法使用，已保留 MinerU 原文：${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else if (await this.fileSystem.exists(displayRepairPath)) {
          diagnostics.push({
            level: "warning",
            code: "mineru-display-repair-unverified",
            message: "display-repair.json 未被正式 manifest 验证，已禁止正文与图注文字修复。"
          });
        }
        const applied = applyMinerUVisualRepair({
          visuals: parsed.visuals,
          viewerIndex: viewerContract,
          visualRepair: effectiveVisualRepair,
          mineruPayload,
          articleMarkdown: article.text,
          articleHash,
          mineruHash,
          sourcePdfPath: hasSourcePdf ? sourcePdfPath : undefined
        });
        let projectedVisuals = applied.visuals;
        let projected = projectMinerUReaderMarkdown({
          markdown: article.text,
          visuals: projectedVisuals,
          viewerIndex: viewerContract,
          articleHash,
          mineruHash
        });
        if (displayRepairPlan) {
          try {
            const repairedVisuals = applyMinerUDisplayCaptionRepairs(projectedVisuals, displayRepairPlan);
            const repairedProjection = projectMinerUReaderMarkdown({
              markdown: article.text,
              visuals: repairedVisuals,
              viewerIndex: viewerContract,
              articleHash,
              mineruHash
            });
            const repairedArticle = applyMinerUDisplayArticleRepairs(repairedProjection.markdown, displayRepairPlan);
            projectedVisuals = repairedVisuals;
            projected = { ...repairedProjection, markdown: repairedArticle };
            diagnostics.push(...displayRepairPlan.diagnostics);
          } catch (error) {
            diagnostics.push({
              level: "warning",
              code: "mineru-display-repair-abstained",
              message: `显示修复无法完整应用，已整体保留 MinerU 原文：${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
        const visibleVisuals = projectedVisuals.filter((visual) => !visual.hidden);
        verificationVisuals = projectedVisuals;
        pageMap = buildMinerUPageMap(article.text, mineruPayload, viewerContract, {
          article: articleHash,
          mineru: mineruHash
        });
        pdfLayout = buildMinerUPdfLayout(viewerContract, visibleVisuals, articleHash, mineruHash);
        if (pageMap) {
          const mapped = pageMap.boundaries.filter((boundary) => boundary.candidates.length).length;
          diagnostics.push({
            level: "info",
            code: "mineru-reader-page-map",
            message: `已为 ${mapped}/${pageMap.pageCount} 个 MinerU 正文页建立确定性阅读边界。`
          });
        }
        visuals = visibleVisuals;
        diagnostics.push(...applied.diagnostics);
        if (hasSourcePdf && this.options.allowRuntimeTextRecovery !== false) {
          captionContinuations = collectPdfCaptionContinuationRequests({
            visuals,
            viewerIndex: viewerContract,
            mineruPayload,
            markdown: article.text
          });
          if (captionContinuations.length) {
            diagnostics.push({
              level: "info",
              code: "mineru-pdf-caption-continuation-candidates",
              message: `检测到 ${captionContinuations.length} 处可由原 PDF 文本层严格恢复的跨栏续图注。`
            });
          }
          paragraphRecoveries = collectMinerUParagraphRecoveryRequests({
            viewerIndex: viewerContract,
            mineruPayload,
            markdown: article.text,
            excludeBlockIds: captionContinuations.map((request) => request.sourceBlockId)
          });
          if (paragraphRecoveries.length) {
            diagnostics.push({
              level: "info",
              code: "mineru-pdf-paragraph-recovery-candidates",
              message: `检测到 ${paragraphRecoveries.length} 个可受限核验的 MinerU 空白正文块。`
            });
          }
        }
        articleText = projected.markdown;
        diagnostics.push(...projected.diagnostics);
        contractVersion = "mineru-viewer-index-v1";
      } catch (error) {
        if (error instanceof PackageLimitError) throw error;
        diagnostics.push({
          level: "warning",
          code: "mineru-visual-repair-invalid",
          message: `视觉修复契约无法使用，已保留 MinerU 原图：${error instanceof Error ? error.message : String(error)}`
        });
      }
    } else if (hasViewerIndex && hasVisualRepair) {
      diagnostics.push({
        level: "warning",
        code: "mineru-unverified-sidecars-ignored",
        message: "检测到未被 manifest/validation 验证的视觉 sidecar；Reader 已忽略并忠实显示原始 MinerU 内容。"
      });
    } else if (hasViewerIndex || hasVisualRepair) {
      diagnostics.push({
        level: "warning",
        code: "mineru-visual-repair-incomplete",
        message: "视觉修复契约不完整，已保留 MinerU 原图显示。"
      });
    }

    const requiredAssetPaths = [...new Set([
      ...verificationVisuals.flatMap((visual) => [visual.path, ...(visual.memberAssetPaths ?? [])]),
      ...(pdfLayout?.blocks.flatMap((block) => block.assetPath ? [block.assetPath] : []) ?? [])
    ])];
    const requiredAssetInfos = await mapWithConcurrency(
      requiredAssetPaths,
      PACKAGE_LIMITS.assetHashConcurrency,
      (path) => this.fileSystem.fileInfo(path)
    );
    const assetInfoByPath = new Map(requiredAssetPaths.map((path, index) => [path, requiredAssetInfos[index]]));
    let totalBytes = 0;
    requiredAssetInfos.forEach((info, index) => {
      const path = requiredAssetPaths[index];
      if (!info) {
        diagnostics.push({ level: "error", code: "mineru-asset-missing", message: `MinerU 资源不存在：${path}` });
        return;
      }
      if (info.size > PACKAGE_LIMITS.assetBytes) {
        throw new PackageLimitError(
          `MinerU asset ${path} is ${info.size} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
          info.size,
          PACKAGE_LIMITS.assetBytes
        );
      }
      totalBytes += info.size;
      if (totalBytes > PACKAGE_LIMITS.totalAssetBytes) {
        throw new PackageLimitError(
          `MinerU assets total ${totalBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`,
          totalBytes,
          PACKAGE_LIMITS.totalAssetBytes
        );
      }
    });
    const assetInfos = visuals.map((visual) => assetInfoByPath.get(visual.path));
    if (pdfLayout) {
      pdfLayout = {
        ...pdfLayout,
        blocks: pdfLayout.blocks.map((block) => block.assetPath && !assetInfoByPath.get(block.assetPath)
          ? { ...block, assetPath: undefined }
          : block)
      };
    }

    const unplaced = visuals.filter((visual) => !visual.placementBlockId).length;
    if (unplaced) {
      diagnostics.push({
        level: "warning",
        code: "mineru-visual-not-in-markdown",
        message: `${unplaced} 个 MinerU 图表未在 Markdown 中找到对应图片引用；仍可从图表侧栏查看。`
      });
    }

    const assets: LoadedAsset[] = visuals.map((visual, index) => ({
      id: visual.id,
      kind: visual.kind,
      path: visual.path,
      display_label: visual.label,
      caption_block_id: null,
      placement_block_id: visual.placementBlockId ?? null,
      vaultPath: this.fileSystem.resolvePath(visual.path),
      exists: Boolean(assetInfos[index]),
      size_bytes: assetInfos[index]?.size,
      captionText: visual.captionText,
      pageIndex: visual.pageIndex,
      sourceBBox: visual.bbox,
      memberAssetPaths: visual.memberAssetPaths,
      memberBlockIds: visual.memberBlockIds,
      captionPageIndex: visual.captionPageIndex,
      captionStatus: visual.captionStatus,
      display: visual.display
    }));

    return {
      state: "mineru",
      sourceFormat: "mineru",
      packageIntegrity: integrity.status,
      visualReview,
      articlePath: this.fileSystem.resolvePath(articleRelativePath),
      articleText,
      articleHash,
      contractPath: this.fileSystem.resolvePath(contentListRelativePath),
      contractVersion,
      anchors: parseAnchorInventory(articleText),
      assets,
      diagnostics,
      sourcePdf: hasSourcePdf ? { path: sourcePdfPath } : undefined,
      pageMap,
      pdfLayout,
      textRecovery: hasSourcePdf && this.options.allowRuntimeTextRecovery !== false ? {
        pdfPath: sourcePdfPath,
        candidates: collectMinerUTextRecoveryCandidates(mineruPayload, article.text),
        sourceArticleText: captionContinuations.length || paragraphRecoveries.length ? article.text : undefined,
        captionContinuations: captionContinuations.length ? captionContinuations : undefined,
        paragraphRecoveries: paragraphRecoveries.length ? paragraphRecoveries : undefined
      } : undefined
    };
  }

  private async loadFallbackAssets(): Promise<LoadedAsset[]> {
    const files = await this.fileSystem.listFiles("images");
    const imageFiles = files
      .filter((path) => IMAGE_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? ""))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (imageFiles.length > PACKAGE_LIMITS.assetCount) {
      throw new PackageLimitError(
        `The images directory contains ${imageFiles.length} supported images; the safe limit is ${PACKAGE_LIMITS.assetCount}.`,
        imageFiles.length,
        PACKAGE_LIMITS.assetCount
      );
    }
    let totalBytes = 0;
    for (const path of imageFiles) {
      const info = await this.fileSystem.fileInfo(path);
      if (!info) continue;
      if (info.size > PACKAGE_LIMITS.assetBytes) {
        throw new PackageLimitError(
          `Paper asset ${path} is ${info.size} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
          info.size,
          PACKAGE_LIMITS.assetBytes
        );
      }
      totalBytes += info.size;
      if (totalBytes > PACKAGE_LIMITS.totalAssetBytes) {
        throw new PackageLimitError(
          `Paper assets total ${totalBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`,
          totalBytes,
          PACKAGE_LIMITS.totalAssetBytes
        );
      }
    }
    return imageFiles
      .map((path) => ({
        id: `fallback:${path}`,
        kind: "unknown",
        display_label: path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path,
        path,
        caption_block_id: null,
        placement_block_id: null,
        vaultPath: this.fileSystem.resolvePath(path),
        exists: true
      }));
  }

  private async loadClippingAssets(visuals: readonly ClippingVisual[], diagnostics: Diagnostic[]): Promise<LoadedAsset[]> {
    if (visuals.length > PACKAGE_LIMITS.assetCount) {
      throw new PackageLimitError(
        `Markdown contains ${visuals.length} paired visuals; the safe limit is ${PACKAGE_LIMITS.assetCount}.`,
        visuals.length,
        PACKAGE_LIMITS.assetCount
      );
    }
    const infos = await mapWithConcurrency(
      visuals,
      PACKAGE_LIMITS.assetHashConcurrency,
      (visual) => this.fileSystem.fileInfo(visual.path)
    );
    let totalBytes = 0;
    infos.forEach((info, index) => {
      if (!info) {
        diagnostics.push({ level: "error", code: "markdown-asset-missing", message: `Markdown 图片不存在：${visuals[index].path}` });
        return;
      }
      if (info.size > PACKAGE_LIMITS.assetBytes) {
        throw new PackageLimitError(
          `Markdown asset ${visuals[index].path} is ${info.size} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
          info.size,
          PACKAGE_LIMITS.assetBytes
        );
      }
      totalBytes += info.size;
      if (totalBytes > PACKAGE_LIMITS.totalAssetBytes) {
        throw new PackageLimitError(
          `Markdown assets total ${totalBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`,
          totalBytes,
          PACKAGE_LIMITS.totalAssetBytes
        );
      }
    });
    return visuals.map((visual, index) => ({
      id: visual.id,
      kind: visual.kind,
      path: visual.path,
      display_label: visual.label,
      caption_block_id: visual.captionBlockId ?? null,
      placement_block_id: visual.placementBlockId,
      vaultPath: this.fileSystem.resolvePath(visual.path),
      exists: Boolean(infos[index]),
      size_bytes: infos[index]?.size,
      captionText: visual.captionText
    }));
  }
}
