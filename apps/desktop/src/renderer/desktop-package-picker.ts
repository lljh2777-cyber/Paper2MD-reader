import { ReaderPackagePicker } from "../../../../packages/reader-core/src/index";
import { Paper2MDDesktopApi } from "../shared/desktop-api";
import { ElectronReaderFileSystem } from "./electron-reader-file-system";

export class DesktopPackagePicker implements ReaderPackagePicker {
  readonly platform = "desktop" as const;

  constructor(private readonly api: Paper2MDDesktopApi) {}

  async choosePackage(): Promise<ElectronReaderFileSystem | undefined> {
    const root = await this.api.choosePackage();
    return root ? new ElectronReaderFileSystem(this.api, root) : undefined;
  }
}
