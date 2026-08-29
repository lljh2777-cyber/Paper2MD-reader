import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINERU_PRECISION_PERMISSION_PATTERNS,
  PRECISION_PERMISSION_LEASE_PORT,
  installPrecisionPermissionLeaseCleanup
} from "../apps/clipper-extension/src/precision-permissions";

interface ExtensionManifest {
  key?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
}

describe("Paper2MD Web Clipper extension boundary", () => {
  const manifest = JSON.parse(
    readFileSync("apps/clipper-extension/manifest.json", "utf8")
  ) as ExtensionManifest;
  const storeManifest = JSON.parse(
    readFileSync("apps/clipper-extension/manifest.store.json", "utf8")
  ) as ExtensionManifest & {
    background?: { service_worker?: string };
    content_security_policy?: { extension_pages?: string };
  };

  it("uses user-initiated activeTab access without persistent page scripts", () => {
    expect(manifest.permissions).toEqual(["activeTab", "downloads", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("keeps network access optional and limited to HTTP image origins", () => {
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("pins the unpacked extension identity used by the local service origin allowlist", () => {
    expect(manifest.key).toMatch(/^MIIB/);
    const digest = createHash("sha256").update(Buffer.from(manifest.key!, "base64")).digest().subarray(0, 16);
    const extensionId = [...digest]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join("");
    expect(extensionId).toBe("fkngpgapepiflkncpicajbmgafebgbip");
    const bridge = readFileSync("apps/clipper-extension/src/processing-bridge.ts", "utf8");
    expect(bridge).toContain('DEFAULT_PROCESSING_SERVICE_ORIGIN = "http://127.0.0.1:8787"');
    expect(bridge).toContain('credentials: "omit"');
    expect(bridge).toContain('redirect: "error"');
    expect(bridge).toContain("Authorization: `Bearer ${token}`");
    expect(bridge).not.toContain("zipSync");
    expect(bridge).not.toContain('from "fflate"');
  });

  it("disables Defuddle third-party fallback and credentialed image requests", () => {
    const extractor = readFileSync("apps/clipper-extension/src/extractor.ts", "utf8");
    const imageFetcher = readFileSync("apps/clipper-extension/src/service-worker.ts", "utf8");
    expect(extractor).toContain("useAsync: false");
    expect(imageFetcher).toContain('credentials: "omit"');
    expect(imageFetcher).toContain('referrerPolicy: "no-referrer"');
    expect(imageFetcher).toContain('redirect: "error"');
    expect(imageFetcher).toContain("readResponseBytesWithinLimit");
    expect(imageFetcher).not.toContain("response.arrayBuffer()");
  });

  it("keeps precision credentials out of persistent extension storage and limits transfer hosts", () => {
    const precisionPage = readFileSync("apps/clipper-extension/src/precision.ts", "utf8");
    const precisionClient = readFileSync("apps/clipper-extension/src/mineru-precision-client.ts", "utf8");
    expect(precisionPage).not.toContain("storage.local");
    expect(precisionPage).not.toContain("storage.sync");
    expect(precisionPage).not.toContain("storage.session");
    expect(precisionPage).not.toContain("cookie");
    expect(precisionPage).not.toContain("localStorage");
    expect(MINERU_PRECISION_PERMISSION_PATTERNS).toEqual([
      "https://mineru.net/*",
      "https://mineru.oss-cn-shanghai.aliyuncs.com/*",
      "https://cdn-mineru.openxlab.org.cn/*"
    ]);
    expect(precisionClient).toContain('credentials: "omit"');
    expect(precisionClient).toContain('redirect: "error"');
    expect(precisionClient).toContain("inspectMineruPrecisionArchive");
  });

  it("keeps the Store build single-purpose and free of Companion permissions", () => {
    expect(storeManifest.key).toBeUndefined();
    expect(storeManifest.permissions).toBeUndefined();
    expect(storeManifest.host_permissions).toBeUndefined();
    expect(storeManifest.optional_host_permissions).toEqual(MINERU_PRECISION_PERMISSION_PATTERNS);
    expect(storeManifest.content_scripts).toBeUndefined();
    expect(storeManifest.background?.service_worker).toBe("store-service-worker.js");
    const policy = storeManifest.content_security_policy?.extension_pages ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).not.toContain("http:");
    const precisionPage = readFileSync("apps/clipper-extension/src/precision.ts", "utf8");
    expect(precisionPage).not.toContain("chrome.downloads");
    expect(precisionPage).not.toContain("chrome.storage");
    expect(precisionPage).not.toContain("localStorage");
    expect(precisionPage).not.toContain("indexedDB");
  });

  it("aborts, clears the in-memory token, revokes an active lease, and closes the port on pagehide", () => {
    const precisionPage = readFileSync("apps/clipper-extension/src/precision.ts", "utf8");
    const handler = /window\.addEventListener\("pagehide", \(\) => \{([\s\S]*?)\n\}\);/u.exec(precisionPage)?.[1] ?? "";
    expect(handler).toContain("activeController?.abort()");
    expect(handler).toContain('tokenInput.value = ""');
    expect(handler).toContain("if (permissionLeaseActive) void removeMineruPrecisionPermissions()");
    expect(handler).toContain("closePermissionLease()");
  });
});

describe("MinerU precision permission lease cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps permissions while any conversion page is connected and removes the exact origins after the final disconnect", () => {
    const connectListeners: Array<(port: chrome.runtime.Port) => void> = [];
    const startupListeners: Array<() => void> = [];
    const installedListeners: Array<() => void> = [];
    const remove = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: { remove },
      runtime: {
        onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connectListeners.push(listener) },
        onStartup: { addListener: (listener: () => void) => startupListeners.push(listener) },
        onInstalled: { addListener: (listener: () => void) => installedListeners.push(listener) }
      }
    } as unknown as typeof chrome);

    installPrecisionPermissionLeaseCleanup();
    expect(connectListeners).toHaveLength(1);
    expect(startupListeners).toHaveLength(1);
    expect(installedListeners).toHaveLength(1);

    const firstDisconnect: Array<() => void> = [];
    const secondDisconnect: Array<() => void> = [];
    const port = (listeners: Array<() => void>) => ({
      name: PRECISION_PERMISSION_LEASE_PORT,
      onDisconnect: { addListener: (listener: () => void) => listeners.push(listener) }
    }) as unknown as chrome.runtime.Port;
    connectListeners[0]!(port(firstDisconnect));
    connectListeners[0]!(port(secondDisconnect));

    startupListeners[0]!();
    firstDisconnect[0]!();
    expect(remove).not.toHaveBeenCalled();

    secondDisconnect[0]!();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
  });

  it("cleans stale grants on startup and installation without treating unrelated ports as leases", () => {
    const connectListeners: Array<(port: chrome.runtime.Port) => void> = [];
    const startupListeners: Array<() => void> = [];
    const installedListeners: Array<() => void> = [];
    const remove = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: { remove },
      runtime: {
        onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connectListeners.push(listener) },
        onStartup: { addListener: (listener: () => void) => startupListeners.push(listener) },
        onInstalled: { addListener: (listener: () => void) => installedListeners.push(listener) }
      }
    } as unknown as typeof chrome);

    installPrecisionPermissionLeaseCleanup();
    connectListeners[0]!({ name: "unrelated-port" } as chrome.runtime.Port);
    startupListeners[0]!();
    installedListeners[0]!();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, { origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
    expect(remove).toHaveBeenNthCalledWith(2, { origins: [...MINERU_PRECISION_PERMISSION_PATTERNS] });
  });
});
