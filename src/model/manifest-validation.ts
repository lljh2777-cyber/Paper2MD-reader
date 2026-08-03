import {
  Diagnostic,
  MARKDOWN_ANCHOR_CONTRACT_VERSION,
  READER_BOUND_MANIFEST_VERSIONS,
  ReaderContract,
  READER_CONTRACT_VERSION
} from "./reader-contract";

const HEX_64 = /^[0-9a-f]{64}$/;
const LEGACY_HYBRID_MANIFEST = /^paper2md-manifest-v0\.[4-7]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function add(
  diagnostics: Diagnostic[],
  level: Diagnostic["level"],
  code: string,
  message: string
): void {
  diagnostics.push({ level, code, message });
}

export function validateManifestBinding(
  raw: unknown,
  contract: ReaderContract,
  readerSha256: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(raw)) {
    add(diagnostics, "error", "invalid-manifest-root", "manifest.json 顶层必须是对象。");
    return diagnostics;
  }

  const supported = typeof raw.manifest_version === "string"
    && (READER_BOUND_MANIFEST_VERSIONS as readonly string[]).includes(raw.manifest_version);
  if (!supported) {
    const legacy = typeof raw.manifest_version === "string" && LEGACY_HYBRID_MANIFEST.test(raw.manifest_version);
    add(
      diagnostics,
      legacy ? "warning" : "error",
      "unsupported-manifest-version",
      legacy
        ? `Reader 契约可读取，但旧 manifest ${raw.manifest_version} 不提供 Reader 完整性绑定。`
        : `不支持 manifest 版本 ${String(raw.manifest_version)}；不会猜测未来清单语义。`
    );
    return diagnostics;
  }

  if (raw.source_sha256 !== contract.source_sha256) {
    add(diagnostics, "error", "manifest-source-mismatch", "manifest 与 reader.json 的 source_sha256 不一致。");
  }

  const reader = raw.reader;
  if (!isRecord(reader) || !hasExactKeys(reader, [
    "contract_version",
    "path",
    "sha256",
    "article_path",
    "article_sha256",
    "anchor_contract"
  ])) {
    add(diagnostics, "error", "invalid-manifest-reader", "manifest 缺少有效的 reader 摘要。");
    return diagnostics;
  }

  if (
    reader.contract_version !== READER_CONTRACT_VERSION ||
    reader.path !== "_paper2md/reader.json" ||
    reader.article_path !== contract.article.path ||
    reader.anchor_contract !== MARKDOWN_ANCHOR_CONTRACT_VERSION
  ) {
    add(diagnostics, "error", "manifest-reader-contract-mismatch", "manifest reader 摘要的契约或路径不匹配。");
  }
  if (typeof reader.sha256 !== "string" || !HEX_64.test(reader.sha256) || reader.sha256 !== readerSha256) {
    add(diagnostics, "error", "manifest-reader-hash-mismatch", "manifest 记录的 reader.json 哈希与实际文件不一致。");
  }
  if (
    typeof reader.article_sha256 !== "string" ||
    !HEX_64.test(reader.article_sha256) ||
    reader.article_sha256 !== contract.article.sha256
  ) {
    add(diagnostics, "error", "manifest-article-hash-mismatch", "manifest 与 reader.json 记录的 article.md 哈希不一致。");
  }

  if (!Array.isArray(raw.outputs)) {
    add(diagnostics, "error", "invalid-manifest-outputs", "manifest.outputs 必须是数组。");
    return diagnostics;
  }
  const outputs = raw.outputs.filter(isRecord);
  const readerOutputs = outputs.filter((output) => output.path === reader.path);
  const articleOutputs = outputs.filter((output) => output.path === reader.article_path);
  const readerOutput = readerOutputs[0];
  const articleOutput = articleOutputs[0];
  if (
    readerOutputs.length !== 1 ||
    !readerOutput ||
    readerOutput.role !== "reader_index" ||
    readerOutput.sha256 !== reader.sha256
  ) {
    add(diagnostics, "error", "manifest-reader-output-mismatch", "manifest reader 摘要与 outputs 清单不一致。");
  }
  if (
    articleOutputs.length !== 1 ||
    !articleOutput ||
    articleOutput.role !== "markdown" ||
    articleOutput.sha256 !== reader.article_sha256
  ) {
    add(diagnostics, "error", "manifest-article-output-mismatch", "manifest article 摘要与 outputs 清单不一致。");
  }
  return diagnostics;
}
