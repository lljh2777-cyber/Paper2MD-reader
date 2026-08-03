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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

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
