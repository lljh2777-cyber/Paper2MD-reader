import {
  MINERU_PRECISION_PERMISSION_PATTERNS,
  runMineruPrecisionConversion,
  validateMineruPrecisionToken,
  validatePrecisionPdf
} from "./mineru-precision-client";
import {
  PRECISION_PERMISSION_LEASE_PORT,
  removeMineruPrecisionPermissions
} from "./precision-permissions";

function requiredElement<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Precision page is missing ${selector}.`);
  return node;
}

const tokenInput = requiredElement<HTMLInputElement>("#mineru-token");
const pdfInput = requiredElement<HTMLInputElement>("#precision-pdf");
const consentInput = requiredElement<HTMLInputElement>("#precision-consent");
const convertButton = requiredElement<HTMLButtonElement>("#convert-button");
const clearButton = requiredElement<HTMLButtonElement>("#clear-token-button");
const revokePermissionsButton = requiredElement<HTMLButtonElement>("#revoke-permissions-button");
const statusElement = requiredElement<HTMLElement>("#precision-status");
const extensionAvailable = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
let running = false;
let validatedFile: File | undefined;
let validationSequence = 0;
let activeController: AbortController | undefined;
let conversionLockHeld = false;
let releaseConversionLock: (() => void) | undefined;
let lockAcquisition: Promise<boolean> | undefined;
let permissionLeaseActive = false;
let permissionLeasePort: chrome.runtime.Port | undefined;
let permissionLeaseHeartbeat: number | undefined;
let intentionallyClosingLease = false;

function setStatus(message: string, state: "working" | "error" | "success" = "working"): void {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

async function downloadArchive(filename: string, bytes: Uint8Array): Promise<void> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function inspectArchiveInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<{
  archive: Uint8Array;
  inspected: {
    fileCount: number;
    markdownCount: number;
    jsonCount: number;
    imageCount: number;
  };
}> {
  if (signal?.aborted) throw new Error("转换已取消，当前页面中的 Token 引用已清除。");
  const worker = new Worker(chrome.runtime.getURL("archive-inspector-worker.js"), { type: "module" });
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new Error("转换已取消，当前页面中的 Token 引用已清除。"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", (event) => {
      finish();
      reject(new Error(event.message || "MinerU ZIP 校验工作线程失败。"));
    }, { once: true });
    worker.addEventListener("message", (event: MessageEvent<{
      ok: boolean;
      archive?: ArrayBuffer;
      inspected?: { fileCount: number; markdownCount: number; jsonCount: number; imageCount: number };
      error?: string;
    }>) => {
      finish();
      if (!event.data.ok || !event.data.archive || !event.data.inspected) {
        reject(new Error(event.data.error || "MinerU ZIP 校验失败。"));
        return;
      }
      resolve({ archive: new Uint8Array(event.data.archive), inspected: event.data.inspected });
    }, { once: true });
    worker.postMessage({ archive: buffer }, [buffer]);
  });
}

function releaseConversionSlot(): void {
  conversionLockHeld = false;
  const release = releaseConversionLock;
  releaseConversionLock = undefined;
  release?.();
}

function closePermissionLease(): void {
  if (permissionLeaseHeartbeat !== undefined) window.clearInterval(permissionLeaseHeartbeat);
  permissionLeaseHeartbeat = undefined;
  const port = permissionLeasePort;
  permissionLeasePort = undefined;
  if (!port) return;
  intentionallyClosingLease = true;
  try { port.disconnect(); }
  finally { intentionallyClosingLease = false; }
}

function openPermissionLease(): void {
  closePermissionLease();
  const port = chrome.runtime.connect({ name: PRECISION_PERMISSION_LEASE_PORT });
  permissionLeasePort = port;
  permissionLeaseHeartbeat = window.setInterval(() => {
    try { port.postMessage({ type: "lease-heartbeat" }); }
    catch { activeController?.abort(); }
  }, 20_000);
  port.onDisconnect.addListener(() => {
    if (permissionLeasePort !== port) return;
    permissionLeasePort = undefined;
    if (permissionLeaseHeartbeat !== undefined) window.clearInterval(permissionLeaseHeartbeat);
    permissionLeaseHeartbeat = undefined;
    if (intentionallyClosingLease || !running) return;
    activeController?.abort();
    void removeMineruPrecisionPermissions();
    setStatus("权限保护连接中断，转换已安全停止；请检查扩展权限。", "error");
  });
}

async function refreshPermissionState(): Promise<void> {
  const retained = await chrome.permissions.contains({ origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
  revokePermissionsButton.hidden = !retained;
}

function acquireConversionSlot(): Promise<boolean> {
  if (conversionLockHeld) return Promise.resolve(true);
  if (lockAcquisition) return lockAcquisition;
  lockAcquisition = new Promise<boolean>((resolve) => {
    void navigator.locks.request("after-mineru-precision-conversion", { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(false); return; }
      conversionLockHeld = true;
      resolve(true);
      await new Promise<void>((release) => { releaseConversionLock = release; });
      conversionLockHeld = false;
    }).catch(() => resolve(false));
  }).finally(() => { lockAcquisition = undefined; });
  return lockAcquisition;
}

function updateConvertAvailability(): void {
  convertButton.disabled = !extensionAvailable
    || running
    || !consentInput.checked
    || !validatedFile
    || validatedFile !== pdfInput.files?.[0]
    || !conversionLockHeld
    || !tokenInput.value.trim();
}

function clearToken(): void {
  if (running && activeController) {
    activeController.abort();
    setStatus("正在取消转换并清除当前页面中的 Token 引用…");
    return;
  }
  tokenInput.value = "";
  updateConvertAvailability();
  setStatus("Token 已从当前页面内存清除。", "success");
}

clearButton.addEventListener("click", clearToken);
revokePermissionsButton.addEventListener("click", () => {
  void (async () => {
    if (running) {
      activeController?.abort();
      setStatus("正在取消任务并撤销 MinerU 域名权限…");
      return;
    }
    const removed = await removeMineruPrecisionPermissions();
    await refreshPermissionState();
    setStatus(removed ? "已撤销 MinerU 域名权限。" : "当前没有可撤销的 MinerU 域名权限。", "success");
  })();
});
tokenInput.addEventListener("input", updateConvertAvailability);
pdfInput.addEventListener("change", () => {
  const sequence = ++validationSequence;
  const file = pdfInput.files?.[0];
  releaseConversionSlot();
  validatedFile = undefined;
  updateConvertAvailability();
  if (!file) {
    setStatus("尚未选择文件；不会自动上传。");
    return;
  }
  setStatus("正在本地验证 PDF 类型与文件头…");
  void validatePrecisionPdf(file).then(() => {
    if (sequence !== validationSequence || file !== pdfInput.files?.[0]) return;
    validatedFile = file;
    setStatus("PDF 已在本地验证；正在检查是否已有转换任务…");
    void acquireConversionSlot().then((acquired) => {
      if (sequence !== validationSequence || file !== pdfInput.files?.[0]) {
        if (acquired) releaseConversionSlot();
        return;
      }
      setStatus(acquired
        ? "PDF 已在本地验证；输入 Token 并确认边界后可开始。"
        : "另一个 After-MinerU 转换页面已占用任务槽，请关闭或等待该页面后重新选择 PDF。", acquired ? "success" : "error");
      updateConvertAvailability();
    });
  }).catch((error: unknown) => {
    if (sequence !== validationSequence) return;
    setStatus(error instanceof Error ? error.message : String(error), "error");
  });
});
consentInput.addEventListener("change", updateConvertAvailability);
window.addEventListener("pagehide", () => {
  activeController?.abort();
  tokenInput.value = "";
  if (permissionLeaseActive) void removeMineruPrecisionPermissions();
  closePermissionLease();
});

convertButton.addEventListener("click", () => {
  void (async () => {
    const file = pdfInput.files?.[0];
    if (!file) { setStatus("请先选择一个 PDF。", "error"); return; }
    if (!consentInput.checked) { setStatus("请先确认数据流，并确认你有权处理所选 PDF。", "error"); return; }
    if (file !== validatedFile) { setStatus("PDF 尚未完成本地验证，请重新选择。", "error"); return; }
    if (!conversionLockHeld) { setStatus("另一个转换页面正在运行，请等待后重新选择 PDF。", "error"); return; }
    let tokenValue = "";
    try {
      tokenValue = validateMineruPrecisionToken(tokenInput.value);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    tokenInput.value = "";
    running = true;
    updateConvertAvailability();
    pdfInput.disabled = true;
    tokenInput.disabled = true;
    consentInput.disabled = true;
    clearButton.textContent = "取消转换";
    activeController = new AbortController();
    openPermissionLease();
    let permissionGranted = false;
    let outcome: { message: string; state: "error" | "success" } | undefined;
    try {
      setStatus("正在请求本次转换所需的三个 MinerU 域名权限…");
      const granted = await chrome.permissions.request({ origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
      if (!granted) throw new Error("你没有授予 MinerU API、签名上传和结果下载权限。");
      permissionGranted = true;
      permissionLeaseActive = true;
      revokePermissionsButton.hidden = false;
      const result = await runMineruPrecisionConversion(file, tokenValue, (progress) => setStatus(progress.message), {
        signal: activeController.signal,
        inspectArchive: inspectArchiveInWorker
      });
      await downloadArchive(result.archiveName, result.archive);
      outcome = {
        message: `校验通过并已生成 ZIP：${result.markdownCount} Markdown、${result.jsonCount} JSON、${result.imageCount} 图片。`,
        state: "success"
      };
    } catch (error) {
      outcome = { message: error instanceof Error ? error.message : String(error), state: "error" };
    } finally {
      tokenValue = "";
      tokenInput.value = "";
      if (permissionGranted) {
        try {
          const removed = await removeMineruPrecisionPermissions();
          permissionLeaseActive = !removed;
          await refreshPermissionState();
          if (!removed) outcome = {
            message: `${outcome?.message ?? "转换已结束"} 浏览器未确认移除 MinerU 域名权限，请在扩展详情页手动撤销。`,
            state: "error"
          };
        } catch {
          outcome = {
            message: `${outcome?.message ?? "转换已结束"} 无法确认 MinerU 域名权限已移除，请在扩展详情页手动检查。`,
            state: "error"
          };
        }
      }
      tokenInput.disabled = false;
      pdfInput.disabled = false;
      consentInput.disabled = false;
      clearButton.textContent = "清除";
      activeController = undefined;
      closePermissionLease();
      releaseConversionSlot();
      validatedFile = undefined;
      validationSequence += 1;
      pdfInput.value = "";
      consentInput.checked = false;
      running = false;
      updateConvertAvailability();
      if (outcome) setStatus(outcome.message, outcome.state);
    }
  })();
});

if (!extensionAvailable) {
  setStatus("请从已安装的 After-MinerU 扩展打开此页面。", "error");
} else {
  void refreshPermissionState().catch(() => {
    revokePermissionsButton.hidden = false;
  });
}
updateConvertAvailability();
