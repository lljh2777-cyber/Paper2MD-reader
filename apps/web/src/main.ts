import "../../../styles.css";
import "../../../local-reader/local-reader.css";
import { mountReaderWorkspace, ReaderWorkspace } from "../../../packages/reader-ui/src/index";
import { BrowserPackagePicker } from "./browser-package-picker";

export function mountWebReader(root: HTMLElement): () => void {
  const workspace: ReaderWorkspace = mountReaderWorkspace(root, {
    picker: new BrowserPackagePicker(),
    title: "Paper2MD Local Reader",
    emptyTitle: "Read a Paper2MD package locally",
    emptyCopy: "Choose a folder containing article.md and _paper2md/reader.json. Files stay on this device.",
    emptyNote: "Read-only · no upload · Chrome or Edge recommended",
    toolbarOpenLabel: "Open folder",
    emptyOpenLabel: "Open paper folder",
    unselectedLabel: "No folder selected"
  });
  return () => workspace.destroy();
}
