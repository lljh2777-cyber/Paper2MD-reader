import { describe, expect, it } from "vitest";
import {
  isProcessingRequestOriginAllowed,
  loadProcessingServiceConfig,
  parseMineruOptions
} from "../apps/processing-service/src/config";
import { safePdfFilename } from "../apps/processing-service/src/job-manager";
import { mineruExtractArgs, mineruSpawnSpec, runMineru } from "../apps/processing-service/src/mineru-runner";
import { flattenMineruElements, normalizePackagePath } from "../apps/processing-service/src/package-publisher";
import { resolve } from "node:path";
import { assertSafeAcquisitionUrl, isPublicInternetAddress } from "../apps/processing-service/src/safe-acquisition-fetch";
import { ClipperCredentialStore } from "../apps/processing-service/src/clipper-credentials";

describe("standalone processing service security", () => {
  it("fails closed for non-public and credentialed acquisition targets", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
      expect(isPublicInternetAddress(address)).toBe(false);
    }
    expect(isPublicInternetAddress("1.1.1.1")).toBe(true);
    expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
    expect(() => assertSafeAcquisitionUrl("http://example.org/paper")).toThrow("HTTPS");
    expect(() => assertSafeAcquisitionUrl("https://user:secret@example.org/paper")).toThrow("credential");
    expect(() => assertSafeAcquisitionUrl("https://127.0.0.1/paper")).toThrow("non-public");
  });
  it("requires authentication before binding beyond loopback", () => {
    expect(() => loadProcessingServiceConfig({ PAPER2MD_SERVICE_HOST: "0.0.0.0" })).toThrow("SERVICE_TOKEN");
    expect(loadProcessingServiceConfig({
      PAPER2MD_SERVICE_HOST: "0.0.0.0",
      PAPER2MD_SERVICE_TOKEN: "test-only-secret"
    }).host).toBe("0.0.0.0");
  });

  it("keeps Streamable HTTP MCP opt-in and loopback-only without an OAuth tenant gateway", () => {
    expect(loadProcessingServiceConfig().enableMcpHttp).toBe(false);
    expect(loadProcessingServiceConfig({ PAPER2MD_ENABLE_MCP_HTTP: "true" }).enableMcpHttp).toBe(true);
    expect(() => loadProcessingServiceConfig({
      PAPER2MD_SERVICE_HOST: "0.0.0.0",
      PAPER2MD_SERVICE_TOKEN: "test-only-secret",
      PAPER2MD_ENABLE_MCP_HTTP: "true"
    })).toThrow("OAuth tenant gateway");
  });

  it("restricts Host headers and validates resolver contact configuration", () => {
    const config = loadProcessingServiceConfig({ PAPER2MD_SERVICE_PORT: "9123" });
    expect(config.allowedHosts).toEqual(new Set(["127.0.0.1:9123", "localhost:9123", "[::1]:9123"]));
    expect(loadProcessingServiceConfig({
      PAPER2MD_ALLOWED_HOSTS: "reader.internal:443",
      PAPER2MD_CONTACT_EMAIL: "maintainer@example.org"
    })).toMatchObject({ contactEmail: "maintainer@example.org", readerBaseUrl: "http://127.0.0.1:4174/" });
    expect(() => loadProcessingServiceConfig({ PAPER2MD_ALLOWED_HOSTS: "reader.internal/path" })).toThrow("allowed host");
    expect(() => loadProcessingServiceConfig({ PAPER2MD_CONTACT_EMAIL: "not-an-email" })).toThrow("CONTACT_EMAIL");
    expect(() => loadProcessingServiceConfig({ PAPER2MD_READER_BASE_URL: "http://reader.example.org" })).toThrow("HTTPS");
  });

  it("limits direct clipping submission to the exact stable extension origin", () => {
    const config = loadProcessingServiceConfig();
    const clipperOrigin = "chrome-extension://fkngpgapepiflkncpicajbmgafebgbip";
    expect(config.allowedClipperOrigins).toEqual(new Set([clipperOrigin]));
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/clippings", clipperOrigin)).toBe(true);
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/clipper/pairings/redeem", clipperOrigin)).toBe(true);
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/clipper/pairings", clipperOrigin)).toBe(false);
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/clippings", undefined)).toBe(false);
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/clippings", "http://127.0.0.1:4174")).toBe(false);
    expect(isProcessingRequestOriginAllowed(config, "/api/v1/health", "http://127.0.0.1:4174")).toBe(true);
    expect(() => loadProcessingServiceConfig({ PAPER2MD_ALLOWED_CLIPPER_IDS: "not-an-extension" })).toThrow("extension ID");
  });

  it("issues one-time origin-bound Clipper credentials with a narrow publish scope", async () => {
    const store = new ClipperCredentialStore("unused-test-root", false);
    const pairing = store.createPairing();
    const origin = "chrome-extension://fkngpgapepiflkncpicajbmgafebgbip";
    const credential = await store.redeem(pairing.pairing_id, pairing.code, origin);
    expect(credential.scope).toBe("clippings:publish");
    expect(await store.authorize(credential.token, origin)).toBe(true);
    expect(await store.authorize(credential.token, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    await expect(store.redeem(pairing.pairing_id, pairing.code, origin)).rejects.toThrow("invalid or expired");
    expect(await store.revokeAll()).toEqual({ revoked: 1 });
    expect(await store.authorize(credential.token, origin)).toBe(false);
  });

  it("accepts only declared MinerU model and language options", () => {
    expect(parseMineruOptions({ "x-paper2md-model": "vlm", "x-paper2md-language": "en" }, 900)).toEqual({
      model: "vlm",
      language: "en",
      timeoutSeconds: 900
    });
    expect(() => parseMineruOptions({ "x-paper2md-model": "../../shell" }, 900)).toThrow("model");
    expect(() => parseMineruOptions({ "x-paper2md-language": "anything" }, 900)).toThrow("language");
  });

  it("builds only precision extract md,json arguments", () => {
    const args = mineruExtractArgs("C:\\jobs\\source.pdf", "C:\\jobs\\extract", {
      model: "pipeline",
      language: "en",
      timeoutSeconds: 600
    });
    expect(args.slice(0, 2)).toEqual(["extract", "C:\\jobs\\source.pdf"]);
    expect(args).toContain("md,json");
    expect(args).toContain("--formula");
    expect(args).toContain("--table");
    expect(args).not.toContain("flash-extract");
  });

  it("uses the configured Windows command processor only for a fixed cmd shim", () => {
    const spec = mineruSpawnSpec("C:\\tools\\mineru-open-api.cmd", ["extract", "C:\\jobs\\source.pdf"]);
    if (process.platform === "win32") {
      expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(spec.args[3]).toContain('"C:\\tools\\mineru-open-api.cmd"');
      expect(spec.args[3]).toContain('"extract"');
      expect(spec.args[3].startsWith('""')).toBe(true);
      expect(spec.args[3].endsWith('""')).toBe(true);
      expect(spec.windowsVerbatimArguments).toBe(true);
    } else {
      expect(spec).toEqual({ command: "C:\\tools\\mineru-open-api.cmd", args: ["extract", "C:\\jobs\\source.pdf"] });
    }
  });

  it.skipIf(process.platform !== "win32")("executes a cmd shim when its path and argument contain spaces", async () => {
    const fixture = resolve("test", "fixtures", "mineru shim.cmd");
    await expect(runMineru(fixture, ["hello world"], process.cwd(), 60)).resolves.toContain("hello world");
  });

  it("normalizes upload names without allowing directory selection", () => {
    expect(safePdfFilename(encodeURIComponent("C:\\papers\\A paper.pdf"))).toBe("A paper.pdf");
    expect(() => safePdfFilename("paper.txt")).toThrow("PDF");
  });

  it("rejects remote, absolute and traversal package resources", () => {
    expect(normalizePackagePath("images/figure%201.png")).toBe("images/figure 1.png");
    for (const path of ["../secret.png", "/etc/passwd", "https://example.com/a.png", "images/%2e%2e/a.png"]) {
      expect(() => normalizePackagePath(path)).toThrow("Unsafe");
    }
  });

  it("flattens MinerU v1 and page-nested v2 without inventing page data", () => {
    expect(flattenMineruElements([{ type: "text", page_idx: 3 }])[0].pageIndex).toBe(3);
    expect(flattenMineruElements([[{ type: "text" }], [{ type: "image" }]])).toEqual([
      expect.objectContaining({ pageIndex: 0 }),
      expect.objectContaining({ pageIndex: 1 })
    ]);
    expect(() => flattenMineruElements([])).toThrow("non-empty");
  });
});
