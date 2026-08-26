import { PDF_MAX_ZOOM, PDF_MIN_ZOOM } from "./pdf-reader-state";

export const READER_VIEW_STATE_VERSION = 1;

export interface ReaderPersistedViewState {
  version: typeof READER_VIEW_STATE_VERSION;
  splitRatio: number;
  articleScrollTop: number;
  referenceMode: "pdf" | "visuals";
  pdfPage: number;
  pdfZoom: number;
  pdfFollowing: boolean;
  showLayoutBoxes: boolean;
  selectedVisualId: string;
  visualFollowing: boolean;
}

export const DEFAULT_READER_VIEW_STATE: ReaderPersistedViewState = {
  version: READER_VIEW_STATE_VERSION,
  splitRatio: 0.68,
  articleScrollTop: 0,
  referenceMode: "visuals",
  pdfPage: 1,
  pdfZoom: 1,
  pdfFollowing: true,
  showLayoutBoxes: true,
  selectedVisualId: "",
  visualFollowing: true
};

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function parseReaderViewState(value: string | null): ReaderPersistedViewState {
  if (!value) return { ...DEFAULT_READER_VIEW_STATE };
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (!raw || raw.version !== READER_VIEW_STATE_VERSION) return { ...DEFAULT_READER_VIEW_STATE };
    return {
      version: READER_VIEW_STATE_VERSION,
      splitRatio: bounded(raw.splitRatio, DEFAULT_READER_VIEW_STATE.splitRatio, 0.42, 0.78),
      articleScrollTop: bounded(raw.articleScrollTop, 0, 0, 100_000_000),
      referenceMode: raw.referenceMode === "pdf" ? "pdf" : "visuals",
      pdfPage: Math.floor(bounded(raw.pdfPage, 1, 1, 100_000)),
      pdfZoom: bounded(raw.pdfZoom, 1, PDF_MIN_ZOOM, PDF_MAX_ZOOM),
      pdfFollowing: typeof raw.pdfFollowing === "boolean" ? raw.pdfFollowing : true,
      showLayoutBoxes: typeof raw.showLayoutBoxes === "boolean" ? raw.showLayoutBoxes : true,
      selectedVisualId: typeof raw.selectedVisualId === "string" && raw.selectedVisualId.length <= 256 ? raw.selectedVisualId : "",
      visualFollowing: typeof raw.visualFollowing === "boolean" ? raw.visualFollowing : true
    };
  } catch {
    return { ...DEFAULT_READER_VIEW_STATE };
  }
}

export function readerViewStateKey(articleHash: string): string | undefined {
  return /^[a-f0-9]{64}$/i.test(articleHash) ? `paper2md-reader:view:v1:${articleHash.toLowerCase()}` : undefined;
}
