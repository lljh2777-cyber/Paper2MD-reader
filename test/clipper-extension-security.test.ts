import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

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
});
