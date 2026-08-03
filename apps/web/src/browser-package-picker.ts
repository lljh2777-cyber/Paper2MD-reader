import { BrowserDirectoryReaderFileSystem } from "../../../src/filesystem/browser-directory-reader-file-system";
import { ReaderPackagePicker } from "../../../packages/reader-core/src/index";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

export class BrowserPackagePicker implements ReaderPackagePicker {
  readonly platform = "web" as const;
  private readonly input: HTMLInputElement;

  constructor() {
    this.input = document.createElement("input");
    this.input.type = "file";
    this.input.multiple = true;
    this.input.setAttribute("webkitdirectory", "");
    this.input.className = "p2md-local-folder-input";
    document.body.appendChild(this.input);
  }

  async choosePackage(): Promise<BrowserDirectoryReaderFileSystem | undefined> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    const forceInputFallback = new URLSearchParams(window.location.search).has("folder-input");
    if (picker && !forceInputFallback) {
      try {
        const handle = await picker.call(window, { mode: "read" });
        return BrowserDirectoryReaderFileSystem.fromDirectoryHandle(handle);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return undefined;
        throw error;
      }
    }
    return new Promise((resolve) => {
      const onChange = () => {
        const files = [...(this.input.files ?? [])];
        this.input.value = "";
        resolve(files.length ? BrowserDirectoryReaderFileSystem.fromFileList(files) : undefined);
      };
      this.input.addEventListener("change", onChange, { once: true });
      this.input.click();
    });
  }

  dispose(): void {
    this.input.remove();
  }
}
