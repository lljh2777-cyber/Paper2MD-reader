import { isSafeRelativePath } from "./contract-validation";
import { PACKAGE_LIMITS, PackageLimitError } from "./package-limits";

export interface ConvertedClippingHtml {
  markdown: string;
  title?: string;
  localImagePaths: string[];
  blockedImageSources: string[];
}

export interface ClippingHtmlConversionOptions {
  sourcePath: string;
  availableImagePaths?: ReadonlySet<string>;
  parseHtml?: (source: string) => Document;
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp)$/i;
const BLOCKED_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "form", "input", "button", "select", "textarea", "video", "audio", "source",
  "track", "canvas", "svg", "nav"
]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "div", "figure", "figcaption", "footer", "header",
  "main", "section", "details", "summary", "dl", "dt", "dd"
]);
const MAX_HTML_NODES = 100_000;
const MAX_TABLE_ROWS = 2_000;
const MAX_TABLE_COLUMNS = 128;
const MAX_TABLE_CELLS = 10_000;

function parseWithBrowser(source: string): Document {
  if (typeof DOMParser === "undefined") throw new Error("HTML import requires a browser DOM parser.");
  return new DOMParser().parseFromString(source, "text/html");
}

function decodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function resolveLocalImagePath(sourcePath: string, value: string): string | undefined {
  const raw = value.trim().split(/[?#]/, 1)[0];
  if (!raw || raw.startsWith("//") || raw.startsWith("/") || raw.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return undefined;
  }
  const decoded = decodePath(raw)?.replace(/\\/g, "/");
  if (!decoded || !IMAGE_EXTENSION.test(decoded)) return undefined;
  const base = sourcePath.replace(/\\/g, "/").split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const path = segments.join("/");
  return isSafeRelativePath(path) ? path : undefined;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/([\\`*_[\]<>])/g, "\\$1")
    .trim();
}

function escapeInlineMarkdown(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/([\\`*_[\]<>])/g, "\\$1");
}

function safeLink(value: string): string | undefined {
  const href = value.trim();
  if (/^(?:https?:|mailto:)/i.test(href)) return href.replace(/[()\s]/g, (character) => encodeURIComponent(character));
  if (href.startsWith("#")) return href;
  return undefined;
}

function block(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `\n\n${trimmed}\n\n` : "";
}

function tableMarkdown(table: Element, render: (node: Node) => string): string {
  const tableRows = [...table.querySelectorAll("tr")];
  if (tableRows.length > MAX_TABLE_ROWS) {
    throw new PackageLimitError("Web clipping table has too many rows.", tableRows.length, MAX_TABLE_ROWS);
  }
  let cellCount = 0;
  const rows = tableRows.map((row) => {
    const cells = [...row.children].filter((cell) => /^(?:td|th)$/i.test(cell.tagName));
    if (cells.length > MAX_TABLE_COLUMNS) {
      throw new PackageLimitError("Web clipping table has too many columns.", cells.length, MAX_TABLE_COLUMNS);
    }
    cellCount += cells.length;
    if (cellCount > MAX_TABLE_CELLS) {
      throw new PackageLimitError("Web clipping table has too many cells.", cellCount, MAX_TABLE_CELLS);
    }
    return cells
    .filter((cell) => /^(?:td|th)$/i.test(cell.tagName))
    .map((cell) => render(cell).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim());
  });
  if (!rows.length || !rows[0].length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  const header = normalized[0];
  const body = normalized.slice(1);
  return block([
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n"));
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convert saved article HTML into a safe, display-only Markdown projection. */
export function convertClippingHtmlToMarkdown(
  source: string,
  options: ClippingHtmlConversionOptions
): ConvertedClippingHtml {
  const document = (options.parseHtml ?? parseWithBrowser)(source);
  const title = escapeMarkdown(document.querySelector("title")?.textContent ?? "") || undefined;
  const root = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  const localImagePaths = new Set<string>();
  const blockedImageSources = new Set<string>();
  let visitedNodes = 0;
  let imageCount = 0;

  const render = (node: Node): string => {
    visitedNodes += 1;
    if (visitedNodes > MAX_HTML_NODES) {
      throw new PackageLimitError("Web clipping HTML contains too many nodes.", visitedNodes, MAX_HTML_NODES);
    }
    if (node.nodeType === 3) return escapeInlineMarkdown(node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (BLOCKED_ELEMENTS.has(tag)) return "";
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "img") {
      imageCount += 1;
      if (imageCount > PACKAGE_LIMITS.assetCount) {
        throw new PackageLimitError(
          "Web clipping HTML contains too many images.",
          imageCount,
          PACKAGE_LIMITS.assetCount
        );
      }
      const rawSource = element.getAttribute("src") ?? "";
      const path = resolveLocalImagePath(options.sourcePath, rawSource);
      const alt = escapeMarkdown(element.getAttribute("alt") ?? "");
      if (!path || options.availableImagePaths && !options.availableImagePaths.has(path)) {
        if (rawSource) blockedImageSources.add(rawSource);
        return alt;
      }
      localImagePaths.add(path);
      return `\n\n![${alt}](${path})\n\n`;
    }
    if (tag === "table") return tableMarkdown(element, render);
    if (tag === "pre") {
      const text = (element.textContent ?? "").replace(/```/g, "`\u200b``").trim();
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : "";
    }

    const children = [...element.childNodes].map(render).join("").replace(/ +\n/g, "\n");
    const text = children.replace(/[ \t]{2,}/g, " ").trim();
    if (!text) return "";
    if (/^h[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${text}`);
    if (tag === "p") return block(text);
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "em" || tag === "i") return `*${text}*`;
    if (tag === "del" || tag === "s") return `~~${text}~~`;
    if (tag === "code") return `\`${text.replace(/`/g, "\\`")}\``;
    if (tag === "a") {
      const href = safeLink(element.getAttribute("href") ?? "");
      return href ? `[${text}](${href})` : text;
    }
    if (tag === "blockquote") return block(text.split("\n").map((line) => `> ${line}`).join("\n"));
    if (tag === "li") return text;
    if (tag === "ul" || tag === "ol") {
      const items = [...element.children]
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((child, index) => `${tag === "ol" ? `${index + 1}.` : "-"} ${render(child).trim()}`);
      return block(items.join("\n"));
    }
    return BLOCK_ELEMENTS.has(tag) ? block(text) : text;
  };

  let markdown = normalizeMarkdown(render(root));
  if (title && !/^#\s+/m.test(markdown)) markdown = `# ${title}\n\n${markdown}`.trim();
  return {
    markdown,
    title,
    localImagePaths: [...localImagePaths],
    blockedImageSources: [...blockedImageSources]
  };
}
