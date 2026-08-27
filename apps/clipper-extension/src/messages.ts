export const EXTRACT_MESSAGE = "paper2md:extract-current-page";
export const FETCH_IMAGE_MESSAGE = "paper2md:fetch-image";

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

export type ExtractPageResponse =
  | { ok: true; page: ExtractedPaperPage }
  | { ok: false; error: string };

export type FetchImageResponse =
  | { ok: true; mime: string; bytesBase64: string }
  | { ok: false; error: string };
