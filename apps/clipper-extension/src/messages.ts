import type { ExtractedPaperPage } from "../../../packages/clipper-core/src/index";
export type { ExtractedPaperPage } from "../../../packages/clipper-core/src/index";

export const EXTRACT_MESSAGE = "paper2md:extract-current-page";
export const FETCH_IMAGE_MESSAGE = "paper2md:fetch-image";

export type ExtractPageResponse =
  | { ok: true; page: ExtractedPaperPage }
  | { ok: false; error: string };

export type FetchImageResponse =
  | { ok: true; mime: string; bytesBase64: string }
  | { ok: false; error: string };
