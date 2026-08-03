import { ReaderFileSystem } from "../filesystem/reader-file-system";
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
import { injectMinerUVisualAnchors, parseMinerUContentList } from "./mineru-content-list";
import { detectPackageSource } from "./package-source";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class PackageLoader {
  constructor(private readonly fileSystem: ReaderFileSystem) {}

  async loadDetected(): Promise<LoadedPaperPackage> {
    const source = await detectPackageSource(this.fileSystem);
    if (source.format === "mineru") return this.loadMinerU(source.articlePath, source.contentListPath);
    const loaded = await this.load(source.articlePath);
    loaded.sourceFormat = source.format;
    return loaded;
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

  async load(articleRelativePath = "article.md"): Promise<LoadedPaperPackage> {
    if (!isSafeRelativePath(articleRelativePath)) throw new Error(`Unsafe article path: ${articleRelativePath}`);
    if (articleRelativePath !== "article.md") {
      const stem = articleRelativePath.replace(/\.md$/i, "");
      const stableContentList = `${stem}_content_list.json`;
      const v2ContentList = `${stem}_content_list_v2.json`;
      if (await this.fileSystem.exists(stableContentList)) return this.loadMinerU(articleRelativePath, stableContentList);
      if (await this.fileSystem.exists(v2ContentList)) return this.loadMinerU(articleRelativePath, v2ContentList);
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
      diagnostics.push({
        level: "info",
        code: "reader-missing",
        message: "未找到 _paper2md/reader.json，已使用普通 Markdown 与图片目录降级。"
      });
      return {
        state: "reader-missing",
        articlePath,
        articleText,
        articleHash,
        anchors,
        assets: await this.loadFallbackAssets(),
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

  private async loadMinerU(articleRelativePath: string, contentListRelativePath: string): Promise<LoadedPaperPackage> {
    if (!isSafeRelativePath(articleRelativePath) || !isSafeRelativePath(contentListRelativePath)) {
      throw new Error("Unsafe MinerU package path");
    }
    const article = await this.readTextWithinLimit(articleRelativePath, PACKAGE_LIMITS.articleBytes, "MinerU Markdown");
    const contentList = await this.readTextWithinLimit(
      contentListRelativePath,
      PACKAGE_LIMITS.mineruContentListBytes,
      "MinerU content list"
    );
    const parsed = parseMinerUContentList(JSON.parse(contentList.text) as unknown);
    if (parsed.visuals.length > PACKAGE_LIMITS.assetCount) {
      throw new PackageLimitError(
        `MinerU content list contains ${parsed.visuals.length} visual assets; the safe limit is ${PACKAGE_LIMITS.assetCount}.`,
        parsed.visuals.length,
        PACKAGE_LIMITS.assetCount
      );
    }

    const articleText = injectMinerUVisualAnchors(article.text, parsed.visuals);
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

    const assetInfos = await mapWithConcurrency(
      parsed.visuals,
      PACKAGE_LIMITS.assetHashConcurrency,
      (visual) => this.fileSystem.fileInfo(visual.path)
    );
    let totalBytes = 0;
    assetInfos.forEach((info, index) => {
      const visual = parsed.visuals[index];
      if (!info) {
        diagnostics.push({ level: "error", code: "mineru-asset-missing", message: `MinerU 资源不存在：${visual.path}` });
        return;
      }
      if (info.size > PACKAGE_LIMITS.assetBytes) {
        throw new PackageLimitError(
          `MinerU asset ${visual.path} is ${info.size} bytes; the safe limit is ${PACKAGE_LIMITS.assetBytes}.`,
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

    const unplaced = parsed.visuals.filter((visual) => !visual.placementBlockId).length;
    if (unplaced) {
      diagnostics.push({
        level: "warning",
        code: "mineru-visual-not-in-markdown",
        message: `${unplaced} 个 MinerU 图表未在 Markdown 中找到对应图片引用；仍可从图表侧栏查看。`
      });
    }

    const assets: LoadedAsset[] = parsed.visuals.map((visual, index) => ({
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
      sourceBBox: visual.bbox
    }));

    return {
      state: "mineru",
      sourceFormat: "mineru",
      articlePath: this.fileSystem.resolvePath(articleRelativePath),
      articleText,
      articleHash: await sha256(article.bytes),
      contractPath: this.fileSystem.resolvePath(contentListRelativePath),
      contractVersion: `mineru-content-list-${parsed.version}`,
      anchors: parseAnchorInventory(articleText),
      assets,
      diagnostics
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
}
