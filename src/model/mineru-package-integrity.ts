import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { isSafeRelativePath } from "./contract-validation";
import { Diagnostic } from "./reader-contract";
import { PACKAGE_LIMITS, PackageLimitError } from "./package-limits";

const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_PATH = "_extraction/manifest.json";
const VALIDATION_PATH = "_extraction/validation.json";
const LEGACY_DERIVED_PATHS = [
  "_extraction/viewer-index.json",
  "_extraction/visual-repair.json",
  "_extraction/visual-candidates.json"
] as const;

type UnknownRecord = Record<string, unknown>;

export interface MinerUManifestFileRecord {
  path: string;
  size: number;
  sha256: string;
}

export interface MinerUPackageIntegrity {
  status: "verified" | "unverified";
  derived: ReadonlyMap<string, MinerUManifestFileRecord>;
  sourcePdfSha256?: string;
  diagnostics: Diagnostic[];
}

export class MinerUPackageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinerUPackageIntegrityError";
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBytes(fileSystem: ReaderFileSystem, path: string, limit: number, label: string): Promise<Uint8Array> {
  const info = await fileSystem.fileInfo(path);
  if (!info) throw new MinerUPackageIntegrityError(`缺少 ${label}：${path}`);
  if (info.size > limit) throw new PackageLimitError(`${label} is ${info.size} bytes; the safe limit is ${limit}.`, info.size, limit);
  return new Uint8Array(await fileSystem.readBinary(path));
}

async function readJson(fileSystem: ReaderFileSystem, path: string, limit: number, label: string): Promise<unknown> {
  const bytes = await readBoundedBytes(fileSystem, path, limit, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new MinerUPackageIntegrityError(`${label} 不是有效 UTF-8 JSON：${path}`);
  }
}

function manifestRecords(value: unknown, label: string, maximumCount: number): Map<string, MinerUManifestFileRecord> {
  if (!Array.isArray(value)) throw new MinerUPackageIntegrityError(`manifest.json 缺少 ${label} 文件清单`);
  if (value.length > maximumCount) {
    throw new PackageLimitError(`${label} contains ${value.length} records; the safe limit is ${maximumCount}.`, value.length, maximumCount);
  }
  const result = new Map<string, MinerUManifestFileRecord>();
  value.forEach((item) => {
    const entry = record(item);
    const path = typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/").replace(/^\.\//, "") : "";
    const size = entry?.size;
    const hash = typeof entry?.sha256 === "string" ? entry.sha256.toLowerCase() : "";
    if (
      !path
      || !isSafeRelativePath(path)
      || result.has(path)
      || !Number.isSafeInteger(size)
      || Number(size) < 0
      || !SHA256.test(hash)
    ) {
      throw new MinerUPackageIntegrityError(`manifest.json 含无效或重复的 ${label} 记录：${path || "<unknown>"}`);
    }
    result.set(path, { path, size: Number(size), sha256: hash });
  });
  return result;
}

async function verifyRecord(
  fileSystem: ReaderFileSystem,
  entry: MinerUManifestFileRecord,
  limit: number,
  knownBytes?: Uint8Array
): Promise<Uint8Array> {
  const info = await fileSystem.fileInfo(entry.path);
  if (!info) throw new MinerUPackageIntegrityError(`manifest.json 登记的文件不存在：${entry.path}`);
  if (info.size !== entry.size) throw new MinerUPackageIntegrityError(`文件大小与 manifest.json 不一致：${entry.path}`);
  if (info.size > limit) throw new PackageLimitError(`${entry.path} is ${info.size} bytes; the safe limit is ${limit}.`, info.size, limit);
  const bytes = knownBytes ?? new Uint8Array(await fileSystem.readBinary(entry.path));
  if (await sha256(bytes) !== entry.sha256) {
    throw new MinerUPackageIntegrityError(`文件哈希与 manifest.json 不一致：${entry.path}`);
  }
  return bytes;
}

export async function inspectMinerUPackageIntegrity(input: {
  fileSystem: ReaderFileSystem;
  articlePath: string;
  articleBytes: Uint8Array;
  mineruPath: string;
  mineruBytes: Uint8Array;
  sourcePdfPath: string;
}): Promise<MinerUPackageIntegrity> {
  const { fileSystem } = input;
  const [hasManifest, hasValidation] = await Promise.all([
    fileSystem.exists(MANIFEST_PATH),
    fileSystem.exists(VALIDATION_PATH)
  ]);
  if (!hasManifest && !hasValidation) {
    return {
      status: "unverified",
      derived: new Map(),
      diagnostics: [{
        level: "warning",
        code: "mineru-package-unverified",
        message: "该目录没有 MinerU manifest/validation，已按普通 MinerU 导出读取；不会将其标记为已验证内容包。"
      }]
    };
  }
  if (!hasManifest || !hasValidation) {
    throw new MinerUPackageIntegrityError("MinerU 正式包的 manifest.json 与 validation.json 必须同时存在");
  }

  const validation = record(await readJson(fileSystem, VALIDATION_PATH, PACKAGE_LIMITS.manifestBytes, "validation.json"));
  if (validation?.status !== "passed") {
    throw new MinerUPackageIntegrityError("该 MinerU 包未通过 _extraction/validation.json 验证，阅读器拒绝加载");
  }

  const manifest = record(await readJson(fileSystem, MANIFEST_PATH, PACKAGE_LIMITS.manifestBytes, "manifest.json"));
  if (!manifest || manifest.schema_version !== 1) throw new MinerUPackageIntegrityError("manifest.json 版本不受支持");
  if (manifest.processing_depth !== "conversion-only") {
    throw new MinerUPackageIntegrityError("manifest.json processing_depth 必须为 conversion-only");
  }
  const outputs = manifestRecords(manifest.outputs, "outputs", PACKAGE_LIMITS.assetCount + 8);
  const derived = manifestRecords(manifest.derived_contracts ?? [], "derived_contracts", 32);
  // Desktop 0.1.0 briefly bound the three generated Reader contracts inside
  // `outputs` instead of `derived_contracts`. Those records are still
  // immutable and SHA-256-bound, so accept only the exact historical paths.
  // Arbitrary output files never gain derived-contract authority.
  for (const path of LEGACY_DERIVED_PATHS) {
    const legacy = outputs.get(path);
    const current = derived.get(path);
    if (legacy && current && (legacy.size !== current.size || legacy.sha256 !== current.sha256)) {
      throw new MinerUPackageIntegrityError(`manifest.json 对派生文件的登记冲突：${path}`);
    }
    if (legacy && !current) derived.set(path, legacy);
  }
  const articleRecord = outputs.get(input.articlePath);
  const mineruRecord = outputs.get(input.mineruPath);
  if (!articleRecord || !mineruRecord) {
    throw new MinerUPackageIntegrityError("manifest.json 未登记当前 article.md 与 mineru-result.json");
  }

  let aggregateBytes = 0;
  for (const entry of outputs.values()) {
    aggregateBytes += entry.size;
    const aggregateLimit = PACKAGE_LIMITS.totalAssetBytes + PACKAGE_LIMITS.articleBytes + PACKAGE_LIMITS.mineruContentListBytes;
    if (aggregateBytes > aggregateLimit) {
      throw new PackageLimitError("Manifest outputs exceed the safe aggregate limit.", aggregateBytes, aggregateLimit);
    }
    const limit = entry.path === input.articlePath
      ? PACKAGE_LIMITS.articleBytes
      : entry.path === input.mineruPath
        ? PACKAGE_LIMITS.mineruContentListBytes
        : PACKAGE_LIMITS.assetBytes;
    await verifyRecord(
      fileSystem,
      entry,
      limit,
      entry.path === input.articlePath ? input.articleBytes : entry.path === input.mineruPath ? input.mineruBytes : undefined
    );
  }

  const hasSourcePdf = await fileSystem.exists(input.sourcePdfPath);
  const options = record(manifest.options);
  if (options?.include_source_pdf === true && !hasSourcePdf) {
    throw new MinerUPackageIntegrityError("manifest.json 声明保留 source.pdf，但包内文件不存在");
  }
  if (hasSourcePdf) {
    const source = record(manifest.source);
    const size = source?.size;
    const hash = typeof source?.sha256 === "string" ? source.sha256.toLowerCase() : "";
    if (!Number.isSafeInteger(size) || Number(size) < 0 || !SHA256.test(hash)) {
      throw new MinerUPackageIntegrityError("manifest.json 缺少有效的 source.pdf 来源大小或哈希");
    }
    await verifyRecord(fileSystem, { path: input.sourcePdfPath, size: Number(size), sha256: hash }, PACKAGE_LIMITS.sourcePdfBytes);
  }

  return {
    status: "verified",
    derived,
    sourcePdfSha256: hasSourcePdf ? String(record(manifest.source)?.sha256).toLowerCase() : undefined,
    diagnostics: [{
      level: "info",
      code: "mineru-package-integrity-verified",
      message: `已核验 MinerU 正式包：${outputs.size} 个原始输出及 source.pdf（如存在）均与 manifest 一致。`
    }]
  };
}

export async function readVerifiedMinerUDerivedJson(
  fileSystem: ReaderFileSystem,
  path: string,
  expected: MinerUManifestFileRecord | undefined
): Promise<unknown> {
  if (!expected) throw new MinerUPackageIntegrityError(`manifest.json 未登记派生文件：${path}`);
  if (expected.path !== path) throw new MinerUPackageIntegrityError(`派生文件路径与 manifest.json 不一致：${path}`);
  const bytes = await verifyRecord(fileSystem, expected, PACKAGE_LIMITS.viewerContractBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new MinerUPackageIntegrityError(`${path} 不是有效 UTF-8 JSON`);
  }
}
