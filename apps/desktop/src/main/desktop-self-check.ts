import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { DesktopSelfCheck, DesktopSelfCheckItem } from "../shared/desktop-api";
import { MINERU_API_BASE_URL } from "../../../processing-service/src/mineru-api-client";

interface DesktopSelfCheckDependencies {
  libraryHealth(): Promise<{ configured: boolean; writable: boolean; atomicPublish: boolean }>;
  credentialsAvailable(): boolean;
  credentialConfigured(): Promise<boolean>;
  mineruReachable(): Promise<boolean>;
  localCliAvailable(): Promise<boolean>;
  now?: () => Date;
}

function item(
  id: DesktopSelfCheckItem["id"],
  status: DesktopSelfCheckItem["status"],
  code: DesktopSelfCheckItem["code"],
  optional = false
): DesktopSelfCheckItem {
  return { id, status, code, ...(optional ? { optional: true } : {}) };
}

export async function runDesktopSelfCheck(dependencies: DesktopSelfCheckDependencies): Promise<DesktopSelfCheck> {
  const credentialsAvailable = dependencies.credentialsAvailable();
  const [library, tokenState, mineruReachable, localCliAvailable] = await Promise.all([
    dependencies.libraryHealth(),
    credentialsAvailable
      ? dependencies.credentialConfigured()
          .then((configured) => configured ? "configured" as const : "missing" as const)
          .catch(() => "unreadable" as const)
      : Promise.resolve("unreadable" as const),
    dependencies.mineruReachable().catch(() => false),
    dependencies.localCliAvailable().catch(() => false)
  ]);
  const items: DesktopSelfCheckItem[] = [
    item(
      "library",
      !library.configured ? "action-required" : library.writable ? "ready" : "unavailable",
      !library.configured ? "LIBRARY_NOT_CONFIGURED" : library.writable ? "LIBRARY_READY" : "LIBRARY_NOT_WRITABLE"
    ),
    item(
      "credentials",
      credentialsAvailable ? "ready" : "unavailable",
      credentialsAvailable ? "CREDENTIALS_READY" : "CREDENTIALS_UNAVAILABLE"
    ),
    item(
      "token",
      tokenState === "configured" ? "ready" : "action-required",
      tokenState === "configured" ? "TOKEN_READY" : tokenState === "missing" ? "TOKEN_NOT_CONFIGURED" : "TOKEN_UNREADABLE"
    ),
    item(
      "mineru-network",
      mineruReachable ? "ready" : "unavailable",
      mineruReachable ? "MINERU_REACHABLE" : "MINERU_UNREACHABLE"
    ),
    item(
      "atomic-publish",
      library.atomicPublish ? "ready" : library.configured ? "unavailable" : "action-required",
      library.atomicPublish ? "ATOMIC_PUBLISH_READY" : "ATOMIC_PUBLISH_UNAVAILABLE"
    ),
    item(
      "local-cli",
      localCliAvailable ? "ready" : "unavailable",
      localCliAvailable ? "LOCAL_CLI_READY" : "LOCAL_CLI_UNAVAILABLE",
      true
    )
  ];
  return {
    checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    readyForMineru: items.filter((entry) => !entry.optional).every((entry) => entry.status === "ready"),
    localCliAvailable,
    items
  };
}

export async function checkMineruReachability(fetchImplementation: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImplementation(`${MINERU_API_BASE_URL}/file-urls/batch`, {
      method: "POST",
      headers: {
        Authorization: "Bearer paper2md-self-check",
        "Content-Type": "application/json",
        source: "paper2md-desktop"
      },
      body: JSON.stringify({
        files: [{ name: "paper2md-self-check.pdf", is_ocr: false }],
        model_version: "vlm",
        language: "en",
        enable_formula: true,
        enable_table: true
      }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    if (response.status !== 401 && response.status !== 403) return false;
    const text = await response.text();
    if (text.length > 16 * 1024) return false;
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return ["A0202", "A0211"].includes(String(record.code ?? record.msgCode ?? ""));
  } catch {
    return false;
  }
}

export async function resolvePaper2mdCommand(
  configured = process.env.PAPER2MD_EXECUTABLE,
  environmentPath = process.env.PATH ?? "",
  platform = process.platform,
  canAccess: (path: string) => Promise<void> = (path) => access(path)
): Promise<string | undefined> {
  const command = configured?.trim() || (platform === "win32" ? "paper2md.exe" : "paper2md");
  if (isAbsolute(command) || /[\\/]/u.test(command)) {
    return canAccess(command).then(() => command).catch(() => undefined);
  }
  const extensions = platform === "win32" && !extname(command)
    ? [".exe", ".cmd", ".bat", ""]
    : [""];
  for (const directory of environmentPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await canAccess(candidate).then(() => true).catch(() => false)) return candidate;
    }
  }
  return undefined;
}
