import { MINERU_PRECISION_PERMISSION_PATTERNS, runMineruPrecisionConversion } from "./mineru-precision-client";

function requiredElement<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Precision page is missing ${selector}.`);
  return node;
}

const tokenInput = requiredElement<HTMLInputElement>("#mineru-token");
const pdfInput = requiredElement<HTMLInputElement>("#precision-pdf");
const convertButton = requiredElement<HTMLButtonElement>("#convert-button");
const clearButton = requiredElement<HTMLButtonElement>("#clear-token-button");
const statusElement = requiredElement<HTMLElement>("#precision-status");

function setStatus(message: string, state: "working" | "error" | "success" = "working"): void {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

async function downloadArchive(filename: string, bytes: Uint8Array): Promise<void> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function clearToken(): void {
  tokenInput.value = "";
  setStatus("Token 已从当前页面内存清除。", "success");
}

clearButton.addEventListener("click", clearToken);
window.addEventListener("pagehide", () => { tokenInput.value = ""; });

convertButton.addEventListener("click", () => {
  void (async () => {
    const file = pdfInput.files?.[0];
    if (!file) { setStatus("请先选择一个 PDF。", "error"); return; }
    if (!tokenInput.value.trim()) { setStatus("请输入临时 MinerU Token。", "error"); return; }
    convertButton.disabled = true;
    pdfInput.disabled = true;
    tokenInput.disabled = true;
    try {
      setStatus("正在请求本次转换所需的三个 MinerU 域名权限…");
      const granted = await chrome.permissions.request({ origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
      if (!granted) throw new Error("你没有授予 MinerU API、签名上传和结果下载权限。");
      const result = await runMineruPrecisionConversion(file, tokenInput.value, (progress) => setStatus(progress.message));
      await downloadArchive(result.archiveName, result.archive);
      setStatus(`校验通过并已生成 ZIP：${result.markdownCount} Markdown、${result.jsonCount} JSON、${result.imageCount} 图片。`, "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      tokenInput.value = "";
      tokenInput.disabled = false;
      pdfInput.disabled = false;
      convertButton.disabled = false;
    }
  })();
});

if (typeof chrome === "undefined" || !chrome.permissions?.request || !chrome.downloads?.download) {
  convertButton.disabled = true;
  setStatus("请从已安装的 After-MinerU 扩展打开此页面。", "error");
}
