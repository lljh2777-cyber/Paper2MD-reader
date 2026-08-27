import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const python = process.platform === "win32" ? "D:\\python\\python.exe" : "python3";
const pythonAvailable = process.platform !== "win32" || existsSync(python);
const contractNames = ["viewer-index.json", "visual-repair.json", "visual-candidates.json"] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe.skipIf(!pythonAvailable)("Python reader-contract golden baseline", () => {
  it("keeps the current deterministic contract output frozen during the TypeScript migration", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "paper2md-contract-golden-"));
    const extractionRoot = join(packageRoot, "_extraction");
    await mkdir(extractionRoot);
    await Promise.all([
      copyFile(join(repositoryRoot, "test", "mineru-package", "paper.md"), join(packageRoot, "article.md")),
      copyFile(join(repositoryRoot, "test", "mineru-package", "paper_content_list.json"), join(packageRoot, "mineru-result.json")),
      writeFile(join(extractionRoot, "source.pdf"), "%PDF-1.4\n%%EOF\n", { encoding: "ascii", flag: "wx" })
    ]);

    await execFileAsync(python, [
      join(repositoryRoot, "apps", "processing-service", "scripts", "build_reader_contracts.py"),
      "--package-root",
      packageRoot
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    for (const name of contractNames) {
      await expect(readJson(join(extractionRoot, name))).resolves.toEqual(
        await readJson(join(repositoryRoot, "test", "fixtures", "reader-contract-golden", name))
      );
    }
  });
});
