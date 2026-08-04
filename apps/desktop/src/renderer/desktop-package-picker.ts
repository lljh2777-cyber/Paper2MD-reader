import { ReaderPackagePicker } from "../../../../packages/reader-core/src/index";
import { DesktopRootSelection, Paper2MDDesktopApi } from "../shared/desktop-api";
import { ElectronReaderFileSystem } from "./electron-reader-file-system";

export class DesktopPackagePicker implements ReaderPackagePicker {
  readonly platform = "desktop" as const;

  constructor(
    private readonly api: Paper2MDDesktopApi,
    private readonly onPackageSelected?: (root: DesktopRootSelection) => Promise<void>
  ) {}

  async choosePackage(): Promise<ElectronReaderFileSystem | undefined> {
    const root = await this.api.choosePackage();
    if (!root) return undefined;
    await this.onPackageSelected?.(root);
    return new ElectronReaderFileSystem(this.api, root);
  }
}
