import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { collectAnchors, materializeContractAnchors, RenderedArticle } from "./contract-renderer";
import { assertMarkdownResourcesSafe, safeLocalResourcePath } from "./markdown-resource-policy";

const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });

function localImagePath(src: string): string | undefined {
  if (!src || src.startsWith("#")) return undefined;
  return safeLocalResourcePath(src);
}

async function bindLocalImageSources(container: HTMLElement, fileSystem: ReaderFileSystem): Promise<void> {
  await Promise.all([...container.querySelectorAll<HTMLImageElement>("img")].map(async (image) => {
    const original = image.dataset.p2mdOriginalSrc ?? image.getAttribute("src") ?? "";
    delete image.dataset.p2mdOriginalSrc;
    const path = localImagePath(original);
    if (!path || !await fileSystem.exists(path)) {
      image.removeAttribute("src");
      image.dataset.p2mdBlockedSource = "true";
      return;
    }
    image.src = await fileSystem.resolveAssetUrl(path);
    image.dataset.p2mdSourcePath = path;
    image.loading = "lazy";
  }));
}

export async function renderLocalArticle(
  markdownSource: string,
  container: HTMLElement,
  fileSystem: ReaderFileSystem,
  materializeAnchors: boolean
): Promise<RenderedArticle> {
  await assertMarkdownResourcesSafe(markdownSource, fileSystem);
  const source = materializeAnchors ? materializeContractAnchors(markdownSource) : markdownSource;
  const html = markdown.render(source);
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "video", "audio", "source", "track"],
    FORBID_ATTR: ["style", "srcset", "poster"]
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  template.content.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    image.dataset.p2mdOriginalSrc = image.getAttribute("src") ?? "";
    image.removeAttribute("src");
  });
  container.replaceChildren(template.content);
  container.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
    link.rel = "noreferrer noopener";
    if (/^https?:/i.test(link.href)) link.target = "_blank";
  });
  await bindLocalImageSources(container, fileSystem);
  return collectAnchors(container);
}
