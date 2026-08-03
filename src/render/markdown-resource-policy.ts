import MarkdownIt from "markdown-it";
import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { isSafeRelativePath } from "../model/contract-validation";
import { PACKAGE_LIMITS, PackageLimitError } from "../model/package-limits";

type MarkdownToken = {
  type: string;
  content: string;
  attrs?: [string, string][] | null;
  children?: MarkdownToken[] | null;
};

const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REMOTE_SCHEME = /^(?:https?|ftp|ws|wss):/i;
const RESOURCE_ATTRIBUTES: Record<string, Set<string>> = {
  audio: new Set(["src"]), embed: new Set(["src"]), iframe: new Set(["src"]),
  img: new Set(["src", "srcset"]), input: new Set(["src"]), object: new Set(["data"]),
  source: new Set(["src", "srcset"]), track: new Set(["src"]), video: new Set(["src", "poster"])
};

export class UnsafeMarkdownResourceError extends Error {
  constructor(readonly resource: string) {
    super(`Paper Markdown contains a blocked or non-package resource: ${resource}`);
    this.name = "UnsafeMarkdownResourceError";
  }
}

export function decodeUriComponentSafely(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function safeLocalResourcePath(value: string): string | undefined {
  const raw = value.trim().split(/[?#]/, 1)[0];
  if (!raw || raw.startsWith("//") || EXPLICIT_SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return undefined;
  }
  const decoded = decodeUriComponentSafely(raw)?.replace(/^\.\//, "");
  if (!decoded || decoded.startsWith("//") || EXPLICIT_SCHEME.test(decoded) || decoded.startsWith("/") || decoded.startsWith("\\")) {
    return undefined;
  }
  return isSafeRelativePath(decoded) ? decoded : undefined;
}

function isRemoteResource(value: string): boolean {
  const normalized = value.trim().replace(/[\u0000-\u0020]+/g, "");
  return normalized.startsWith("//") || REMOTE_SCHEME.test(normalized);
}

function tokenAttribute(token: MarkdownToken, name: string): string | undefined {
  return token.attrs?.find(([attribute]) => attribute === name)?.[1];
}

function collectTokenResources(tokens: readonly MarkdownToken[], resources: string[]): void {
  for (const token of tokens) {
    if (token.type === "image") {
      const source = tokenAttribute(token, "src");
      if (source) resources.push(source);
    }
    if (token.type === "html_inline" || token.type === "html_block") collectHtmlResources(token.content, resources);
    if (token.children) collectTokenResources(token.children, resources);
  }
}

function collectHtmlResources(html: string, resources: string[]): void {
  const tagPattern = /<(audio|embed|iframe|img|input|object|source|track|video)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(html))) {
    const tag = tagMatch[1].toLowerCase();
    const attributePattern = /\b(src|srcset|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(tagMatch[2]))) {
      const attribute = attributeMatch[1].toLowerCase();
      if (!RESOURCE_ATTRIBUTES[tag]?.has(attribute)) continue;
      const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
      if (attribute === "srcset") {
        value.split(",").map((item) => item.trim().split(/\s+/, 1)[0]).filter(Boolean).forEach((item) => resources.push(item));
      } else if (value) resources.push(value);
    }
  }
}

function collectWikiEmbeds(source: string, resources: string[]): void {
  const wikiEmbed = /!\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiEmbed.exec(source))) {
    const target = match[1].split("|", 1)[0].split("#", 1)[0].trim();
    if (target) resources.push(target);
  }
}

export function inspectMarkdownResources(source: string): { localPaths: string[]; blockedUrls: string[]; resourceCount: number } {
  const resources: string[] = [];
  collectTokenResources(markdown.parse(source, {}) as MarkdownToken[], resources);
  collectWikiEmbeds(source, resources);
  const localPaths = new Set<string>();
  const blockedUrls = new Set<string>();
  for (const resource of resources) {
    const normalizedResource = markdown.utils.unescapeAll(resource);
    if (isRemoteResource(normalizedResource)) {
      blockedUrls.add(normalizedResource);
      continue;
    }
    const localPath = safeLocalResourcePath(normalizedResource);
    if (localPath) localPaths.add(localPath);
    else blockedUrls.add(normalizedResource);
  }
  return { localPaths: [...localPaths], blockedUrls: [...blockedUrls], resourceCount: resources.length };
}

export async function assertMarkdownResourcesSafe(source: string, fileSystem: ReaderFileSystem): Promise<void> {
  const { localPaths, blockedUrls, resourceCount } = inspectMarkdownResources(source);
  if (blockedUrls.length) throw new UnsafeMarkdownResourceError(blockedUrls[0]);
  if (resourceCount > PACKAGE_LIMITS.renderedResourceCount) {
    throw new PackageLimitError(
      `Paper Markdown references ${resourceCount} resources; the safe limit is ${PACKAGE_LIMITS.renderedResourceCount}.`,
      resourceCount,
      PACKAGE_LIMITS.renderedResourceCount
    );
  }
  let totalBytes = 0;
  for (const path of localPaths) {
    const info = await fileSystem.fileInfo(path);
    if (!info) throw new UnsafeMarkdownResourceError(path);
    if (info.size > PACKAGE_LIMITS.assetBytes) {
      throw new PackageLimitError(
        `Paper resource ${path} is ${info.size} bytes; the safe per-resource limit is ${PACKAGE_LIMITS.assetBytes}.`,
        info.size,
        PACKAGE_LIMITS.assetBytes
      );
    }
    totalBytes += info.size;
    if (totalBytes > PACKAGE_LIMITS.totalAssetBytes) {
      throw new PackageLimitError(
        `Paper Markdown resources total ${totalBytes} bytes; the safe aggregate limit is ${PACKAGE_LIMITS.totalAssetBytes}.`,
        totalBytes,
        PACKAGE_LIMITS.totalAssetBytes
      );
    }
  }
}
