import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PAPER2MD_READER_VIEW, Paper2MDReaderView } from "./views/Paper2MDReaderView";

export default class Paper2MDReaderPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(PAPER2MD_READER_VIEW, (leaf: WorkspaceLeaf) => new Paper2MDReaderView(leaf));

    this.addCommand({
      id: "open-in-paper2md-reader",
      name: "Open in Paper2MD Reader",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible = file instanceof TFile && file.extension.toLowerCase() === "md";
        if (eligible && !checking) void this.openReader(file);
        return eligible;
      }
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
      menu.addItem((item) => item
        .setTitle("Open in Paper2MD Reader")
        .setIcon("book-open")
        .onClick(() => void this.openReader(file)));
    }));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(PAPER2MD_READER_VIEW);
  }

  private async openReader(file: TFile): Promise<void> {
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: PAPER2MD_READER_VIEW,
        active: true,
        state: { articlePath: file.path }
      });
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      console.error("Paper2MD Reader could not open", error);
      new Notice("Could not open Paper2MD Reader.");
    }
  }
}
