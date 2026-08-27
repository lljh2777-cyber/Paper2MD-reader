import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
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
    expect(manifest.permissions).toEqual(["activeTab", "downloads", "scripting"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("keeps network access optional and limited to HTTP image origins", () => {
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
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
