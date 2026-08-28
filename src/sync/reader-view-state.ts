import { PDF_MAX_ZOOM, PDF_MIN_ZOOM } from "./pdf-reader-state";

export const READER_VIEW_STATE_VERSION = 2;

export interface ReaderArticleAnchor {
  targetId: string;
  label: string;
  level: number;
  /** Reading progress between this heading and the next retained outline heading. */
  sectionProgress: number;
}

export interface ReaderPersistedViewState {
  version: typeof READER_VIEW_STATE_VERSION;
  splitRatio: number;
  /** Retained for diagnostics only. Restoration requires a verified articleAnchor. */
  articleScrollTop: number;
  articleAnchor?: ReaderArticleAnchor;
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
  articleAnchor: undefined,
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

function articleAnchor(value: unknown): ReaderArticleAnchor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim() : "";
  if (
    !targetId
    || targetId.length > 256
    || !label
    || label.length > 500
    || !Number.isInteger(raw.level)
    || Number(raw.level) < 1
    || Number(raw.level) > 6
    || typeof raw.sectionProgress !== "number"
    || !Number.isFinite(raw.sectionProgress)
    || raw.sectionProgress < 0
    || raw.sectionProgress > 1
  ) return undefined;
  return {
    targetId,
    label,
    level: Number(raw.level),
    sectionProgress: raw.sectionProgress
  };
}

export function parseReaderViewState(value: string | null): ReaderPersistedViewState {
  if (!value) return { ...DEFAULT_READER_VIEW_STATE };
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (!raw || (raw.version !== 1 && raw.version !== READER_VIEW_STATE_VERSION)) {
      return { ...DEFAULT_READER_VIEW_STATE };
    }
    const anchor = raw.version === READER_VIEW_STATE_VERSION ? articleAnchor(raw.articleAnchor) : undefined;
    return {
      version: READER_VIEW_STATE_VERSION,
      splitRatio: bounded(raw.splitRatio, DEFAULT_READER_VIEW_STATE.splitRatio, 0.42, 0.78),
      // A raw pixel from v1, or a v2 pixel without a matching anchor, cannot
      // prove that the projected document still has the same geometry.
      articleScrollTop: anchor ? bounded(raw.articleScrollTop, 0, 0, 100_000_000) : 0,
      articleAnchor: anchor,
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
  // Keep the established key so v1 settings can be migrated without trusting
  // their now-unsafe articleScrollTop value.
  return /^[a-f0-9]{64}$/i.test(articleHash) ? `paper2md-reader:view:v1:${articleHash.toLowerCase()}` : undefined;
}
