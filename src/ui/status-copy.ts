import { PackageState } from "../model/reader-contract";
import { readerText, ReaderLocale, ReaderMessageKey } from "./locale";

const STATUS_DEFINITIONS: Record<PackageState, { key: ReaderMessageKey; tone: string }> = {
  valid: { key: "statusValid", tone: "ok" },
  "edited-with-anchors": { key: "statusEdited", tone: "warning" },
  recoverable: { key: "statusRecoverable", tone: "warning" },
  ambiguous: { key: "statusAmbiguous", tone: "error" },
  "reader-missing": { key: "statusReaderMissing", tone: "neutral" },
  "unsupported-version": { key: "statusUnsupported", tone: "error" },
  "invalid-contract": { key: "statusInvalid", tone: "error" }
};

export function statusCopy(state: PackageState, locale: ReaderLocale): { label: string; tone: string } {
  const definition = STATUS_DEFINITIONS[state];
  return { label: readerText(locale, definition.key), tone: definition.tone };
}

export const STATUS_COPY: Record<PackageState, { label: string; tone: string }> = Object.fromEntries(
  Object.keys(STATUS_DEFINITIONS).map((state) => [state, statusCopy(state as PackageState, "en")])
) as Record<PackageState, { label: string; tone: string }>;
