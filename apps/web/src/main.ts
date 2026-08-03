import "../../../styles.css";
import "../../../local-reader/local-reader.css";
import { mountReaderWorkspace, ReaderWorkspace } from "../../../packages/reader-ui/src/index";
import { BrowserPackagePicker } from "./browser-package-picker";
import { readerText, ReaderLocale } from "../../../src/ui/locale";

function webCopy(locale: ReaderLocale) {
  return {
    title: readerText(locale, "webTitle"),
    emptyTitle: readerText(locale, "webEmptyTitle"),
    emptyCopy: readerText(locale, "webEmptyCopy"),
    emptyNote: readerText(locale, "webEmptyNote"),
    toolbarOpenLabel: readerText(locale, "openFolder"),
    emptyOpenLabel: readerText(locale, "openPaperFolder"),
    unselectedLabel: readerText(locale, "webNoFolder")
  };
}

export function mountWebReader(root: HTMLElement): () => void {
  const workspace: ReaderWorkspace = mountReaderWorkspace(root, {
    picker: new BrowserPackagePicker(),
    localizedCopy: { en: webCopy("en"), "zh-CN": webCopy("zh-CN") }
  });
  return () => workspace.destroy();
}
