import { PackageState } from "../model/reader-contract";

export const STATUS_COPY: Record<PackageState, { label: string; tone: string }> = {
  valid: { label: "Contract valid", tone: "ok" },
  "edited-with-anchors": { label: "Article edited · anchors valid", tone: "warning" },
  recoverable: { label: "Anchor mismatch", tone: "warning" },
  ambiguous: { label: "Anchor conflict", tone: "error" },
  "reader-missing": { label: "Markdown fallback", tone: "neutral" },
  "unsupported-version": { label: "Unsupported contract", tone: "error" },
  "invalid-contract": { label: "Invalid contract", tone: "error" }
};
