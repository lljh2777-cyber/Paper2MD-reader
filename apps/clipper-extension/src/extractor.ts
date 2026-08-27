import Defuddle from "defuddle/full";
import { EXTRACT_MESSAGE, type ExtractPageResponse } from "./messages";

declare global {
  interface Window {
    __paper2mdExtractorInstalled?: boolean;
  }
}

function readable(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

if (!window.__paper2mdExtractorInstalled) {
  window.__paper2mdExtractorInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== EXTRACT_MESSAGE) return;
    try {
      const result = new Defuddle(document, {
        markdown: true,
        useAsync: false,
        removeSmallImages: true,
        removeHiddenElements: true
      }).parse();
      const markdown = readable(result.content);
      if (markdown.length < 200) throw new Error("当前页面没有提取到足够的论文正文。");
      const response: ExtractPageResponse = {
        ok: true,
        page: {
          title: readable(result.title) || readable(document.title) || "Untitled paper",
          author: readable(result.author),
          published: readable(result.published),
          description: readable(result.description),
          sourceUrl: location.href,
          language: readable(result.language) || readable(document.documentElement.lang),
          wordCount: Number.isFinite(result.wordCount) ? Number(result.wordCount) : 0,
          markdown
        }
      };
      sendResponse(response);
    } catch (error) {
      const response: ExtractPageResponse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      sendResponse(response);
    }
  });
}
