import { describe, expect, it } from "vitest";
import {
  isBlockedSitePath,
  isAllowedSiteMethod,
  methodNotAllowedResponse,
  notFoundResponse,
  withSiteSecurityHeaders
} from "../sites-reader/worker/security";

describe("Sites worker security boundary", () => {
  it("allows only the read-only methods required by the Reader", () => {
    expect(isAllowedSiteMethod("GET")).toBe(true);
    expect(isAllowedSiteMethod("HEAD")).toBe(true);
    expect(isAllowedSiteMethod("POST")).toBe(false);
    expect(isAllowedSiteMethod("PUT")).toBe(false);
    expect(isAllowedSiteMethod("DELETE")).toBe(false);
  });

  it("returns an explicit method rejection", async () => {
    const response = withSiteSecurityHeaders(methodNotAllowedResponse());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("keeps the unused server-side image optimizer unreachable", async () => {
    expect(isBlockedSitePath("/_vinext/image")).toBe(true);
    expect(isBlockedSitePath("/")).toBe(false);

    const response = withSiteSecurityHeaders(notFoundResponse());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("adds restrictive public-site headers without losing the original response", async () => {
    const response = withSiteSecurityHeaders(new Response("reader", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    }));

    expect(await response.text()).toBe("reader");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' blob: data:");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });
});
