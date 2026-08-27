export const MAX_CLIPPED_IMAGES = 256;
export const MAX_CLIPPED_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_CLIPPED_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_CLIPPED_ARTICLE_BYTES = 32 * 1024 * 1024;
export const MAX_CLIPPING_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface ExtractedPaperPage {
  title: string;
  author: string;
  published: string;
  description: string;
  sourceUrl: string;
  language: string;
  wordCount: number;
  markdown: string;
}

export interface MarkdownImageOccurrence {
  raw: string;
  alt: string;
  source: string;
  absoluteUrl?: string;
  start: number;
  end: number;
}

export interface LocalizedImage {
  url: string;
  path: string;
  mime: string;
  bytes: Uint8Array;
}

const STANDALONE_MARKDOWN_IMAGE = /^[\t ]*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:[\t ]+["'][^"']*["'])?\)[\t ]*$/gm;
const ALLOWED_IMAGE_PROTOCOL = /^https?:$/;

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

export function isFetchableImageUrl(value: URL): boolean {
  const hostname = value.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return ALLOWED_IMAGE_PROTOCOL.test(value.protocol)
    && !value.username
    && !value.password
    && hostname.includes(".")
    && !hostname.includes(":")
    && hostname !== "localhost"
    && !hostname.endsWith(".localhost")
    && !hostname.endsWith(".local")
    && !isPrivateIpv4(hostname);
}

export async function readResponseBytesWithinLimit(response: Response, maxBytes = MAX_CLIPPED_IMAGE_BYTES): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid image size limit.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Image exceeds the safe size limit.");
        throw new Error("Image exceeds the safe size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function collectMarkdownImages(markdown: string, baseUrl: string): MarkdownImageOccurrence[] {
  const occurrences: MarkdownImageOccurrence[] = [];
  let match: RegExpExecArray | null;
  while ((match = STANDALONE_MARKDOWN_IMAGE.exec(markdown))) {
    const source = (match[2] || match[3] || "").trim();
    let absoluteUrl: string | undefined;
    try {
      const absolute = new URL(source, baseUrl);
      if (isFetchableImageUrl(absolute)) absoluteUrl = absolute.href;
    } catch {
      // The occurrence is still neutralized below instead of reaching Reader.
    }
    occurrences.push({
      raw: match[0],
      alt: match[1].trim(),
      source,
      absoluteUrl,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return occurrences;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\[\]\\]/g, (character) => `\\${character}`).trim();
}

export function localizeMarkdownImages(
  markdown: string,
  occurrences: readonly MarkdownImageOccurrence[],
  localized: ReadonlyMap<string, LocalizedImage>
): string {
  let projected = markdown;
  [...occurrences].sort((left, right) => right.start - left.start).forEach((occurrence) => {
    const image = occurrence.absoluteUrl ? localized.get(occurrence.absoluteUrl) : undefined;
    const alt = escapeMarkdownLabel(occurrence.alt || "Paper figure");
    const replacement = image
      ? `![${alt}](${image.path})`
      : occurrence.absoluteUrl
        ? `[${alt} · image not included](${occurrence.absoluteUrl})`
        : `${alt} · image not included`;
    projected = `${projected.slice(0, occurrence.start)}${replacement}${projected.slice(occurrence.end)}`;
  });
  return projected;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim());
}

function markdownHeading(value: string): string {
  return value
    .replace(/[\u0000-\u0020\u007f]+/g, " ")
    .replace(/([\\`*{}\[\]()#+\-.!_>])/g, "\\$1")
    .trim() || "Untitled paper";
}

export function buildArticleMarkdown(page: ExtractedPaperPage, content: string, created: string): string {
  const frontmatter = [
    "---",
    `title: ${yamlString(page.title)}`,
    `source: ${yamlString(page.sourceUrl)}`,
    `author: ${yamlString(page.author)}`,
    `published: ${yamlString(page.published)}`,
    `created: ${yamlString(created)}`,
    `description: ${yamlString(page.description)}`,
    `language: ${yamlString(page.language)}`,
    "tags:",
    "  - paper2md-web-clipping",
    "---"
  ].join("\n");
  const body = content.trim();
  const title = body.startsWith("# ") ? "" : `# ${markdownHeading(page.title)}\n\n`;
  return `${frontmatter}\n\n${title}${body}\n`;
}

export function safeArchiveName(title: string): string {
  const safe = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${safe || "paper"}.paper2md.zip`;
}

export function extensionForMime(mime: string): string | undefined {
  const normalized = mime.split(";", 1)[0].trim().toLowerCase();
  return ({
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  } as Record<string, string>)[normalized];
}
