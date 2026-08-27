export function normalizePackagePath(rawPath: string): string {
  let decoded = rawPath.trim().replace(/^<|>$/g, "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    throw new Error(`Package path contains malformed percent encoding: ${rawPath}`);
  }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/, 1)[0];
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
    normalized.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error(`Unsafe package asset path: ${rawPath}`);
  return segments.join("/");
}
