import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function normalizeDesktopRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error("Unsafe package path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Unsafe package path");
  }
  return segments.join("/");
}

export async function resolvePackagePath(root: string, value: string): Promise<string> {
  const normalized = normalizeDesktopRelativePath(value);
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, ...normalized.split("/"));
  const rel = relative(canonicalRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Package path escapes selected root");
  }
  let current = canonicalRoot;
  for (const segment of normalized.split("/")) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}
