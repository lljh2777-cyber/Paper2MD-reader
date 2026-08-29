export const MINERU_PRECISION_PERMISSION_PATTERNS = [
  "https://mineru.net/*",
  "https://mineru.oss-cn-shanghai.aliyuncs.com/*",
  "https://cdn-mineru.openxlab.org.cn/*"
] as const;

export const PRECISION_PERMISSION_LEASE_PORT = "after-mineru-precision-permission-lease";

export async function removeMineruPrecisionPermissions(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
}

export function installPrecisionPermissionLeaseCleanup(): void {
  let activeLeases = 0;
  const removeIfIdle = () => {
    if (activeLeases === 0) void removeMineruPrecisionPermissions();
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PRECISION_PERMISSION_LEASE_PORT) return;
    activeLeases += 1;
    port.onDisconnect.addListener(() => {
      activeLeases = Math.max(0, activeLeases - 1);
      removeIfIdle();
    });
  });
  chrome.runtime.onStartup.addListener(removeIfIdle);
  chrome.runtime.onInstalled.addListener(removeIfIdle);
}
