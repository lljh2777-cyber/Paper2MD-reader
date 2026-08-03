import { describe, expect, it } from "vitest";
import { localizedTaskMessage, localizedTaskState } from "../apps/desktop/src/renderer/desktop-copy";
import { ConversionTask } from "../apps/desktop/src/shared/desktop-api";
import { normalizeReaderLocale, readerText } from "../src/ui/locale";
import { statusCopy } from "../src/ui/status-copy";

const task: ConversionTask = {
  id: "task-1",
  pdfName: "paper.pdf",
  outputName: "paper",
  workflow: "reviewed-layout",
  stage: "layout-review",
  state: "awaiting-review",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  message: "12 page review tasks are ready; add final-layout.json to every page"
};

describe("Reader locale", () => {
  it("normalizes supported browser language tags", () => {
    expect(normalizeReaderLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeReaderLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeReaderLocale("en-US")).toBe("en");
    expect(normalizeReaderLocale("fr-FR")).toBeUndefined();
  });

  it("provides translated and interpolated shared UI copy", () => {
    expect(readerText("en", "openNamed", { name: "Figure 1" })).toBe("Open Figure 1");
    expect(readerText("zh-CN", "openNamed", { name: "图 1" })).toBe("打开图 1");
    expect(readerText("zh-CN", "readerDiagnostics")).toBe("阅读器诊断");
  });

  it("localizes package states without changing their tone", () => {
    expect(statusCopy("recoverable", "en")).toEqual({ label: "Anchor mismatch", tone: "warning" });
    expect(statusCopy("recoverable", "zh-CN")).toEqual({ label: "锚点不匹配", tone: "warning" });
    expect(statusCopy("mineru", "zh-CN")).toEqual({ label: "MinerU 结构化结果", tone: "ok" });
  });

  it("localizes desktop task states and structured progress messages", () => {
    expect(localizedTaskState(task, "zh-CN")).toBe("等待审阅");
    expect(localizedTaskMessage(task, "zh-CN")).toBe(
      "12 个页面审阅任务已就绪；请为每页添加 final-layout.json"
    );
    expect(localizedTaskMessage(task, "en")).toBe(task.message);
  });
});
