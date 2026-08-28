import { describe, expect, it } from "vitest";
import {
  checkMineruReachability,
  resolvePaper2mdCommand,
  runDesktopSelfCheck
} from "../apps/desktop/src/main/desktop-self-check";

describe("desktop first-run self-check", () => {
  it("reports a MinerU-ready system without requiring the optional local CLI", async () => {
    const result = await runDesktopSelfCheck({
      libraryHealth: async () => ({ configured: true, writable: true, atomicPublish: true }),
      credentialsAvailable: () => true,
      credentialConfigured: async () => true,
      mineruReachable: async () => true,
      localCliAvailable: async () => false,
      now: () => new Date("2026-08-28T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      checkedAt: "2026-08-28T00:00:00.000Z",
      readyForMineru: true,
      localCliAvailable: false
    });
    expect(result.items.at(-1)).toMatchObject({
      id: "local-cli",
      status: "unavailable",
      optional: true
    });
  });

  it("fails closed when setup, protected storage, network, and publishing are unavailable", async () => {
    const result = await runDesktopSelfCheck({
      libraryHealth: async () => ({ configured: false, writable: false, atomicPublish: false }),
      credentialsAvailable: () => false,
      credentialConfigured: async () => {
        throw new Error("must not read credentials without protection");
      },
      mineruReachable: async () => false,
      localCliAvailable: async () => false
    });

    expect(result.readyForMineru).toBe(false);
    expect(result.items.map((entry) => [entry.id, entry.status, entry.code])).toEqual([
      ["library", "action-required", "LIBRARY_NOT_CONFIGURED"],
      ["credentials", "unavailable", "CREDENTIALS_UNAVAILABLE"],
      ["token", "action-required", "TOKEN_UNREADABLE"],
      ["mineru-network", "unavailable", "MINERU_UNREACHABLE"],
      ["atomic-publish", "action-required", "ATOMIC_PUBLISH_UNAVAILABLE"],
      ["local-cli", "unavailable", "LOCAL_CLI_UNAVAILABLE"]
    ]);
  });

  it("probes the fixed MinerU submission endpoint without creating a task", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const reachable = await checkMineruReachability((async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ msgCode: "A0202", data: null }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch);

    expect(reachable).toBe(true);
    expect(requestedUrl).toBe("https://mineru.net/api/v4/file-urls/batch");
    expect(requestedInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(requestedInit?.headers).toMatchObject({
      Authorization: "Bearer paper2md-self-check",
      source: "paper2md-desktop"
    });
  });

  it("does not mark an unrelated HTTP response as a healthy submission API", async () => {
    await expect(checkMineruReachability((async () => new Response(null, { status: 404 })) as typeof fetch))
      .resolves.toBe(false);
    await expect(checkMineruReachability((async () => new Response("blocked", { status: 403 })) as typeof fetch))
      .resolves.toBe(false);
  });

  it("resolves only an accessible configured Paper2MD command", async () => {
    expect(await resolvePaper2mdCommand(
      "C:\\Paper2MD\\paper2md.exe",
      "",
      "win32",
      async (path) => {
        if (path !== "C:\\Paper2MD\\paper2md.exe") throw new Error("missing");
      }
    )).toBe("C:\\Paper2MD\\paper2md.exe");

    expect(await resolvePaper2mdCommand(
      "C:\\Paper2MD\\missing.exe",
      "",
      "win32",
      async () => { throw new Error("missing"); }
    )).toBeUndefined();
  });
});
