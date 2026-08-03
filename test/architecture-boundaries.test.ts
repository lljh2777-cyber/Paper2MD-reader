import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDesktopRelativePath } from "../apps/desktop/src/main/path-security";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("host boundaries", () => {
  it("keeps shared packages and the web host free of privileged desktop imports", () => {
    const roots = ["packages/reader-core", "packages/reader-ui", "apps/web"];
    const forbidden = /(?:from\s+["'](?:electron|node:fs|node:child_process)|require\(["'](?:electron|node:fs|node:child_process))/;
    const violations = roots.flatMap((root) => sourceFiles(root)
      .filter((path) => forbidden.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path)));
    expect(violations).toEqual([]);
  });

  it("rejects absolute, parent, empty-segment and Windows package paths", () => {
    for (const path of ["../article.md", "images//figure.png", "./article.md", "C:/paper/article.md", "images\\figure.png"]) {
      expect(() => normalizeDesktopRelativePath(path)).toThrow("Unsafe package path");
    }
    expect(normalizeDesktopRelativePath("_paper2md/reader.json")).toBe("_paper2md/reader.json");
  });
});
